import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// --- Types ---

export interface TriggerConfig {
  type: 'email' | 'slack' | 'webhook' | 'file_change' | 'cron';
  match?: Record<string, unknown>;
  prompt?: string;
  debounce?: number;
  schedule?: string; // cron expression (for type: 'cron')
}

export interface GroupEvents {
  triggers: TriggerConfig[];
  outputs?: {
    slack?: string[];
    gdrive?: string;
  };
}

export interface IncomingEvent {
  type: 'email' | 'slack' | 'webhook' | 'file_change' | 'cron';
  variables: Record<string, string>;
  rawContent: string;
}

// --- Glob matching ---

/**
 * Simple glob match supporting `*` (any chars except `/`) and `**` (any chars including `/`).
 * Used for email from patterns and file path patterns.
 */
export function globMatch(value: string, pattern: string): boolean {
  // Escape regex special chars except * and ?
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      regex += '.*';
      i++; // skip second *
    } else if (ch === '*') {
      regex += '[^/]*';
    } else if (ch === '?') {
      regex += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regex += '\\' + ch;
    } else {
      regex += ch;
    }
  }
  return new RegExp(`^${regex}$`, 'i').test(value);
}

// --- Config loading ---

const VALID_TRIGGER_TYPES = new Set([
  'email',
  'slack',
  'webhook',
  'file_change',
  'cron',
]);

export function loadGroupEvents(groupDir: string): GroupEvents | null {
  const eventsPath = path.join(groupDir, 'events.yaml');
  if (!fs.existsSync(eventsPath)) return null;

  try {
    const raw = fs.readFileSync(eventsPath, 'utf-8');
    const parsed = YAML.parse(raw) as GroupEvents;

    if (!parsed?.triggers || !Array.isArray(parsed.triggers)) {
      logger.warn(
        { groupDir },
        'events.yaml missing or invalid triggers array',
      );
      return null;
    }

    // Validate trigger types
    for (const trigger of parsed.triggers) {
      if (!VALID_TRIGGER_TYPES.has(trigger.type)) {
        logger.warn(
          { groupDir, type: trigger.type },
          'Unknown trigger type in events.yaml',
        );
      }
    }

    return parsed;
  } catch (err) {
    logger.error({ groupDir, err }, 'Failed to parse events.yaml');
    return null;
  }
}

export function loadAllGroupEvents(
  registeredGroups: Record<string, RegisteredGroup>,
): Map<string, GroupEvents> {
  const result = new Map<string, GroupEvents>();

  for (const group of Object.values(registeredGroups)) {
    const groupDir = path.join(GROUPS_DIR, group.folder);
    const events = loadGroupEvents(groupDir);
    if (events) {
      result.set(group.folder, events);
      logger.info(
        { group: group.folder, triggerCount: events.triggers.length },
        'Loaded events.yaml',
      );
    }
  }

  return result;
}

// --- Prompt template rendering ---

export function renderPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_, key) => vars[key] ?? `{{${key}}}`,
  );
}

// --- Helpers ---

export function hasWebhookTriggers(
  groupEvents: Map<string, GroupEvents>,
): boolean {
  for (const events of groupEvents.values()) {
    if (events.triggers.some((t) => t.type === 'webhook')) return true;
  }
  return false;
}

export function hasFileChangeTriggers(
  groupEvents: Map<string, GroupEvents>,
): boolean {
  for (const events of groupEvents.values()) {
    if (events.triggers.some((t) => t.type === 'file_change')) return true;
  }
  return false;
}

export function getCronTriggers(
  groupEvents: Map<string, GroupEvents>,
): Array<{ groupFolder: string; trigger: TriggerConfig }> {
  const result: Array<{ groupFolder: string; trigger: TriggerConfig }> = [];
  for (const [folder, events] of groupEvents) {
    for (const trigger of events.triggers) {
      if (trigger.type === 'cron') {
        result.push({ groupFolder: folder, trigger });
      }
    }
  }
  return result;
}
