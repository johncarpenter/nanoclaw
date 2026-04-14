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

      if (buffer.length > MAX_IMAGE_SIZE) {
        logger.warn(
          { fileId: marker.fileId, size: buffer.length },
          'Image too large, skipping',
        );
        continue;
      }

      images.push({
        mediaType: marker.mimetype as ImageBlock['mediaType'],
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
