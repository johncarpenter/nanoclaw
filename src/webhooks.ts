import http from 'http';

import { EventRouter } from './event-router.js';
import { IncomingEvent } from './events.js';
import { logger } from './logger.js';

const MAX_BODY_SIZE = 1_048_576; // 1MB

export function createWebhookServer(
  router: EventRouter,
  port = 7890,
): http.Server {
  const server = http.createServer(async (req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Webhook receiver: POST /hooks/:source
    if (req.method === 'POST' && req.url?.startsWith('/hooks/')) {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body);

        const event: IncomingEvent = {
          type: 'webhook',
          variables: {
            path: req.url.split('?')[0], // strip query string
            method: 'POST',
            event_type:
              parsed?.type ??
              (req.headers['x-github-event'] as string) ??
              'unknown',
            payload: JSON.stringify(parsed, null, 2),
            headers: JSON.stringify(req.headers),
          },
          rawContent: JSON.stringify(parsed, null, 2),
        };

        // Route asynchronously — don't block the HTTP response
        router.route(event).catch((err) => {
          logger.error({ err, url: req.url }, 'Error routing webhook event');
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        logger.error({ err, url: req.url }, 'Error processing webhook');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
      return;
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, () => {
    logger.info({ port }, 'Webhook listener started');
  });

  return server;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    req.on('error', reject);
  });
}
