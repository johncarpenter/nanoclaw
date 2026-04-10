import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  globMatch,
  loadGroupEvents,
  renderPrompt,
  hasWebhookTriggers,
  hasFileChangeTriggers,
  getCronTriggers,
  GroupEvents,
} from './events.js';

describe('globMatch', () => {
  it('matches wildcard email patterns', () => {
    expect(globMatch('billing@harvest.com', '*@harvest.com')).toBe(true);
    expect(globMatch('john@other.com', '*@harvest.com')).toBe(false);
  });

  it('matches exact strings', () => {
    expect(globMatch('hello', 'hello')).toBe(true);
    expect(globMatch('hello', 'world')).toBe(false);
  });

  it('matches file path patterns with single wildcard', () => {
    expect(
      globMatch('gdrive/shared/financials/report.md', 'gdrive/shared/financials/*.md'),
    ).toBe(true);
    expect(
      globMatch('gdrive/shared/financials/deep/report.md', 'gdrive/shared/financials/*.md'),
    ).toBe(false);
  });

  it('matches double wildcard for recursive paths', () => {
    expect(
      globMatch('gdrive/shared/financials/deep/report.md', 'gdrive/**/*.md'),
    ).toBe(true);
  });

  it('is case insensitive', () => {
    expect(globMatch('John@Harvest.com', '*@harvest.com')).toBe(true);
  });

  it('handles question mark wildcard', () => {
    expect(globMatch('file1.txt', 'file?.txt')).toBe(true);
    expect(globMatch('file12.txt', 'file?.txt')).toBe(false);
  });
});

describe('renderPrompt', () => {
  it('replaces template variables', () => {
    const result = renderPrompt(
      'Email from {{from}}: {{subject}}',
      { from: 'john@test.com', subject: 'Hello' },
    );
    expect(result).toBe('Email from john@test.com: Hello');
  });

  it('preserves unknown variables', () => {
    const result = renderPrompt('Value: {{unknown}}', {});
    expect(result).toBe('Value: {{unknown}}');
  });

  it('handles multiple occurrences', () => {
    const result = renderPrompt('{{name}} is {{name}}', { name: 'test' });
    expect(result).toBe('test is test');
  });
});

describe('loadGroupEvents', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-events-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no events.yaml exists', () => {
    expect(loadGroupEvents(tmpDir)).toBeNull();
  });

  it('loads valid events.yaml', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'events.yaml'),
      `triggers:
  - type: email
    match:
      from: "*@harvest.com"
    prompt: "Email from {{from}}"
  - type: webhook
    match:
      path: "/hooks/stripe"
`,
    );
    const result = loadGroupEvents(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.triggers).toHaveLength(2);
    expect(result!.triggers[0].type).toBe('email');
    expect(result!.triggers[1].type).toBe('webhook');
  });

  it('returns null for invalid yaml', () => {
    fs.writeFileSync(path.join(tmpDir, 'events.yaml'), '{ invalid yaml :::');
    expect(loadGroupEvents(tmpDir)).toBeNull();
  });

  it('returns null when triggers is not an array', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'events.yaml'),
      'triggers: "not an array"\n',
    );
    expect(loadGroupEvents(tmpDir)).toBeNull();
  });

  it('loads outputs config', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'events.yaml'),
      `triggers:
  - type: email
    match:
      from: "*@test.com"
outputs:
  slack: ["#finance"]
  gdrive: "shared/financials"
`,
    );
    const result = loadGroupEvents(tmpDir);
    expect(result!.outputs!.slack).toEqual(['#finance']);
    expect(result!.outputs!.gdrive).toBe('shared/financials');
  });
});

describe('helper functions', () => {
  it('hasWebhookTriggers returns true when webhooks exist', () => {
    const events = new Map<string, GroupEvents>([
      ['finance', { triggers: [{ type: 'webhook', match: { path: '/hooks/stripe' } }] }],
    ]);
    expect(hasWebhookTriggers(events)).toBe(true);
  });

  it('hasWebhookTriggers returns false when no webhooks', () => {
    const events = new Map<string, GroupEvents>([
      ['finance', { triggers: [{ type: 'email' }] }],
    ]);
    expect(hasWebhookTriggers(events)).toBe(false);
  });

  it('hasFileChangeTriggers detects file_change triggers', () => {
    const events = new Map<string, GroupEvents>([
      ['devops', { triggers: [{ type: 'file_change', match: { paths: ['*.md'] } }] }],
    ]);
    expect(hasFileChangeTriggers(events)).toBe(true);
  });

  it('getCronTriggers extracts cron triggers with group info', () => {
    const events = new Map<string, GroupEvents>([
      [
        'finance',
        {
          triggers: [
            { type: 'cron', schedule: '0 8 1 * *', prompt: 'Monthly report' },
            { type: 'email' },
          ],
        },
      ],
      [
        'devops',
        {
          triggers: [{ type: 'cron', schedule: '0 9 * * 1', prompt: 'Weekly check' }],
        },
      ],
    ]);
    const crons = getCronTriggers(events);
    expect(crons).toHaveLength(2);
    expect(crons[0].groupFolder).toBe('finance');
    expect(crons[1].groupFolder).toBe('devops');
  });
});
