/**
 * Image attachment utilities for NanoClaw.
 * Handles parsing image markers from stored messages, downloading,
 * and encoding images for Claude's multimodal content blocks.
 */

import { Channel, ImageAttachment, ImageBlock } from './types.js';
import { logger } from './logger.js';

const IMAGE_MARKER_RE = /\[image:([\w]+):([\w]+):(image\/[\w]+):([^\]]+)\]/g;
const SUPPORTED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB per image (Claude limit)
const MAX_IMAGES_PER_PROMPT = 4;

/** Magic byte signatures for validating downloaded image data. */
const MAGIC_BYTES: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/gif': [0x47, 0x49, 0x46],
  'image/webp': [0x52, 0x49, 0x46, 0x46], // RIFF header
};

/** Detect actual image type from buffer magic bytes. */
function detectMimeType(buffer: Buffer): string | null {
  for (const [mime, bytes] of Object.entries(MAGIC_BYTES)) {
    if (bytes.every((b, i) => buffer[i] === b)) return mime;
  }
  return null;
}

/** Build a marker string to embed in message content (stored in SQLite). */
export function buildImageMarker(
  channel: string,
  fileId: string,
  mimetype: string,
  url: string,
): string {
  return `[image:${channel}:${fileId}:${mimetype}:${url}]`;
}

/** Extract image markers from message content. */
export function extractImageMarkers(content: string): ImageAttachment[] {
  const markers: ImageAttachment[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(IMAGE_MARKER_RE.source, IMAGE_MARKER_RE.flags);
  while ((match = re.exec(content)) !== null) {
    const mimetype = match[3];
    if (!SUPPORTED_TYPES.has(mimetype)) continue;
    markers.push({
      marker: match[0],
      channel: match[1],
      fileId: match[2],
      mimetype,
      url: match[4],
    });
  }
  return markers;
}

/** Strip image markers from content, replacing with a note. */
export function stripImageMarkers(content: string): string {
  return content.replace(IMAGE_MARKER_RE, '').trim();
}

/**
 * Download and base64-encode images from markers.
 * Uses the channel's downloadFile method for authenticated downloads.
 */
export async function downloadImages(
  markers: ImageAttachment[],
  channel: Channel,
): Promise<ImageBlock[]> {
  if (!channel.downloadFile) return [];

  const limited = markers.slice(0, MAX_IMAGES_PER_PROMPT);
  const images: ImageBlock[] = [];

  for (const marker of limited) {
    try {
      const buffer = await channel.downloadFile(marker.url);

      if (buffer.length === 0) {
        logger.warn(
          { fileId: marker.fileId },
          'Downloaded empty image, skipping',
        );
        continue;
      }

      if (buffer.length > MAX_IMAGE_SIZE) {
        logger.warn(
          { fileId: marker.fileId, size: buffer.length },
          'Image too large, skipping',
        );
        continue;
      }

      // Validate magic bytes — reject downloads that aren't real images
      // (e.g., Slack returning an HTML error page instead of the file)
      const detected = detectMimeType(buffer);
      if (!detected) {
        logger.warn(
          {
            fileId: marker.fileId,
            declared: marker.mimetype,
            size: buffer.length,
            header: buffer.subarray(0, 8).toString('hex'),
          },
          'Downloaded data is not a valid image (bad magic bytes), skipping',
        );
        continue;
      }
      const actualType = detected;
      if (detected !== marker.mimetype) {
        logger.warn(
          { fileId: marker.fileId, declared: marker.mimetype, detected },
          'Image mimetype mismatch, using detected type',
        );
      }

      logger.info(
        { fileId: marker.fileId, size: buffer.length, mediaType: actualType },
        'Image downloaded and validated',
      );

      images.push({
        mediaType: actualType as ImageBlock['mediaType'],
        base64Data: buffer.toString('base64'),
      });
    } catch (err) {
      logger.warn({ fileId: marker.fileId, err }, 'Failed to download image');
    }
  }

  return images;
}

/**
 * Extract all image markers from an array of messages.
 * Returns deduplicated markers.
 */
export function extractAllImageMarkers(
  messages: Array<{ content: string }>,
): ImageAttachment[] {
  const seen = new Set<string>();
  const all: ImageAttachment[] = [];

  for (const msg of messages) {
    for (const marker of extractImageMarkers(msg.content)) {
      if (!seen.has(marker.fileId)) {
        seen.add(marker.fileId);
        all.push(marker);
      }
    }
  }

  return all;
}
