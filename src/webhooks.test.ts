import http from 'http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWebhookServer } from './webhooks.js';

function makeRouterMock() {
  return {
    route: vi.fn().mockResolvedValue(undefined),
    updateGroupEvents: vi.fn(),
  };
}

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('webhook server', () => {
  let server: http.Server;
  let port: number;
  let router: ReturnType<typeof makeRouterMock>;

  beforeEach(async () => {
    router = makeRouterMock();
    // Use port 0 for random available port
    server = createWebhookServer(router as never, 0);
    await new Promise<void>((resolve) => {
      server.on('listening', () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('responds to health check', async () => {
    const res = await request(port, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('routes webhook POST to event router', async () => {
    const res = await request(port, 'POST', '/hooks/stripe', {
      type: 'invoice.paid',
      data: { amount: 100 },
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    // Give async route call a tick to execute
    await new Promise((r) => setTimeout(r, 10));

    expect(router.route).toHaveBeenCalledTimes(1);
    const event = router.route.mock.calls[0][0];
    expect(event.type).toBe('webhook');
    expect(event.variables.path).toBe('/hooks/stripe');
    expect(event.variables.event_type).toBe('invoice.paid');
  });

  it('returns 404 for unknown paths', async () => {
    const res = await request(port, 'GET', '/unknown');
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, method: 'POST', path: '/hooks/test' },
          (r) => {
            const chunks: Buffer[] = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () =>
              resolve({
                status: r.statusCode!,
                body: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        req.on('error', reject);
        req.write('not json');
        req.end();
      },
    );
    expect(res.status).toBe(400);
  });

  it('extracts GitHub event type from header', async () => {
    const res = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            method: 'POST',
            path: '/hooks/github',
            headers: {
              'Content-Type': 'application/json',
              'x-github-event': 'push',
            },
          },
          (r) => {
            const chunks: Buffer[] = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () =>
              resolve({
                status: r.statusCode!,
                body: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        req.on('error', reject);
        req.write(JSON.stringify({ ref: 'refs/heads/main' }));
        req.end();
      },
    );

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));

    const event = router.route.mock.calls[0][0];
    expect(event.variables.event_type).toBe('push');
  });
});
