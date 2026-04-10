import { describe, expect, it, vi } from 'vitest';

import { EventRouter, EventRouterDeps } from './event-router.js';
import { GroupEvents, IncomingEvent } from './events.js';

// Minimal mock deps — dispatch is tested via the enqueueTask spy
function makeDeps(overrides?: Partial<EventRouterDeps>): EventRouterDeps {
  return {
    registeredGroups: () => ({
      'finance@g.us': {
        name: 'Finance',
        folder: 'finance',
        trigger: '@Andy',
        added_at: '2026-01-01',
      },
      'devops@g.us': {
        name: 'DevOps',
        folder: 'devops',
        trigger: '@Andy',
        added_at: '2026-01-01',
      },
    }),
    queue: {
      enqueueTask: vi.fn(),
      registerProcess: vi.fn(),
      closeStdin: vi.fn(),
      notifyIdle: vi.fn(),
    } as never,
    channels: [],
    findChannel: () => undefined,
    getSessions: () => ({}),
    setSessions: vi.fn(),
    ...overrides,
  };
}

describe('EventRouter matching', () => {
  it('matches email triggers by from pattern', async () => {
    const deps = makeDeps();
    const groupEvents = new Map<string, GroupEvents>([
      [
        'finance',
        {
          triggers: [
            {
              type: 'email',
              match: { from: '*@harvest.com' },
              prompt: 'Email from {{from}}: {{subject}}',
            },
          ],
        },
      ],
    ]);

    const router = new EventRouter(groupEvents, deps);

    await router.route({
      type: 'email',
      variables: { from: 'billing@harvest.com', subject: 'Invoice', body: '' },
      rawContent: 'Invoice email',
    });

    expect(deps.queue.enqueueTask).toHaveBeenCalledTimes(1);
    const call = (deps.queue.enqueueTask as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('finance@g.us'); // dispatched to finance group
  });

  it('does not match email triggers when from pattern mismatches', async () => {
    const deps = makeDeps();
    const groupEvents = new Map<string, GroupEvents>([
      [
        'finance',
        {
          triggers: [
            { type: 'email', match: { from: '*@harvest.com' } },
          ],
        },
      ],
    ]);

    const router = new EventRouter(groupEvents, deps);

    await router.route({
      type: 'email',
      variables: { from: 'john@other.com', subject: '', body: '' },
      rawContent: 'other email',
    });

    expect(deps.queue.enqueueTask).not.toHaveBeenCalled();
  });

  it('matches slack keyword triggers', async () => {
    const deps = makeDeps();
    const groupEvents = new Map<string, GroupEvents>([
      [
        'finance',
        {
          triggers: [
            {
              type: 'slack',
              match: {
                channels: ['#general'],
                keywords: ['invoice', 'payment'],
              },
              prompt: 'Finance message: {{message}}',
            },
          ],
        },
      ],
    ]);

    const router = new EventRouter(groupEvents, deps);

    await router.route({
      type: 'slack',
      variables: {
        channel: '#general',
        message: 'Please check the invoice status',
        user: 'john',
      },
      rawContent: 'Please check the invoice status',
    });

    expect(deps.queue.enqueueTask).toHaveBeenCalledTimes(1);
  });

  it('does not match slack keyword triggers when keywords absent', async () => {
    const deps = makeDeps();
    const groupEvents = new Map<string, GroupEvents>([
      [
        'finance',
        {
          triggers: [
            {
              type: 'slack',
              match: { keywords: ['invoice', 'payment'] },
            },
          ],
        },
      ],
    ]);

    const router = new EventRouter(groupEvents, deps);

    await router.route({
      type: 'slack',
      variables: { channel: '#general', message: 'Hello team', user: 'john' },
      rawContent: 'Hello team',
    });

    expect(deps.queue.enqueueTask).not.toHaveBeenCalled();
  });

  it('matches webhook triggers by path and event type', async () => {
    const deps = makeDeps();
    const groupEvents = new Map<string, GroupEvents>([
      [
        'finance',
        {
          triggers: [
            {
              type: 'webhook',
              match: {
                path: '/hooks/stripe',
                events: ['invoice.payment_failed', 'invoice.paid'],
              },
              prompt: 'Stripe event: {{event_type}}',
            },
          ],
        },
      ],
    ]);

    const router = new EventRouter(groupEvents, deps);

    await router.route({
      type: 'webhook',
      variables: {
        path: '/hooks/stripe',
        event_type: 'invoice.paid',
        method: 'POST',
        payload: '{}',
        headers: '{}',
      },
      rawContent: '{}',
    });

    expect(deps.queue.enqueueTask).toHaveBeenCalledTimes(1);
  });

  it('does not match webhook with wrong event type', async () => {
    const deps = makeDeps();
    const groupEvents = new Map<string, GroupEvents>([
      [
        'finance',
        {
          triggers: [
            {
              type: 'webhook',
              match: {
                path: '/hooks/stripe',
                events: ['invoice.paid'],
              },
            },
          ],
        },
      ],
    ]);

    const router = new EventRouter(groupEvents, deps);

    await router.route({
      type: 'webhook',
      variables: {
        path: '/hooks/stripe',
        event_type: 'customer.created',
        method: 'POST',
        payload: '{}',
        headers: '{}',
      },
      rawContent: '{}',
    });

    expect(deps.queue.enqueueTask).not.toHaveBeenCalled();
  });

  it('matches file_change triggers by glob path', async () => {
    const deps = makeDeps();
    const groupEvents = new Map<string, GroupEvents>([
      [
        'finance',
        {
          triggers: [
            {
              type: 'file_change',
              match: { paths: ['gdrive/shared/financials/*.md'] },
              prompt: 'File changed: {{path}}',
            },
          ],
        },
      ],
    ]);

    const router = new EventRouter(groupEvents, deps);

    await router.route({
      type: 'file_change',
      variables: { path: 'gdrive/shared/financials/report.md', event: 'modified' },
      rawContent: 'file modified',
    });

    expect(deps.queue.enqueueTask).toHaveBeenCalledTimes(1);
  });

  it('dispatches to multiple groups for the same event', async () => {
    const deps = makeDeps();
    const groupEvents = new Map<string, GroupEvents>([
      [
        'finance',
        {
          triggers: [
            { type: 'slack', match: { keywords: ['budget'] } },
          ],
        },
      ],
      [
        'devops',
        {
          triggers: [
            { type: 'slack', match: { keywords: ['budget'] } },
          ],
        },
      ],
    ]);

    const router = new EventRouter(groupEvents, deps);

    await router.route({
      type: 'slack',
      variables: { channel: '#general', message: 'The budget is approved', user: 'ceo' },
      rawContent: 'The budget is approved',
    });

    expect(deps.queue.enqueueTask).toHaveBeenCalledTimes(2);
  });

  it('ignores cron triggers (handled by scheduler)', async () => {
    const deps = makeDeps();
    const groupEvents = new Map<string, GroupEvents>([
      [
        'finance',
        {
          triggers: [
            { type: 'cron', schedule: '0 8 * * *', prompt: 'Daily check' },
          ],
        },
      ],
    ]);

    const router = new EventRouter(groupEvents, deps);

    // Cron events should never be routed through the event router
    await router.route({
      type: 'cron',
      variables: {},
      rawContent: '',
    });

    expect(deps.queue.enqueueTask).not.toHaveBeenCalled();
  });

  it('skips dispatch when group is not registered', async () => {
    const deps = makeDeps({
      registeredGroups: () => ({}), // no groups registered
    });
    const groupEvents = new Map<string, GroupEvents>([
      [
        'unknown',
        {
          triggers: [{ type: 'email', match: { from: '*' } }],
        },
      ],
    ]);

    const router = new EventRouter(groupEvents, deps);

    await router.route({
      type: 'email',
      variables: { from: 'a@b.com', subject: '', body: '' },
      rawContent: '',
    });

    expect(deps.queue.enqueueTask).not.toHaveBeenCalled();
  });

  it('uses raw content when no prompt template defined', async () => {
    const deps = makeDeps();
    const groupEvents = new Map<string, GroupEvents>([
      [
        'finance',
        {
          triggers: [
            { type: 'slack', match: { mention: true } },
          ],
        },
      ],
    ]);

    const router = new EventRouter(groupEvents, deps);

    await router.route({
      type: 'slack',
      variables: { message: 'Hello', user: 'john', isMention: 'true' },
      rawContent: 'Hello @Andy',
    });

    expect(deps.queue.enqueueTask).toHaveBeenCalledTimes(1);
  });
});
