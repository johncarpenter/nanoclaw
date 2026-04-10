import fs from 'fs';
import path from 'path';

import { EventRouter } from './event-router.js';
import { GroupEvents, IncomingEvent } from './events.js';
import { logger } from './logger.js';

const DEFAULT_DEBOUNCE_MS = 30_000;

export class FileWatcher {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private watchers: fs.FSWatcher[] = [];
  private debounceMs: number;

  constructor(
    private router: EventRouter,
    private configs: Map<string, GroupEvents>,
    debounceMs?: number,
  ) {
    // Use the smallest debounce from any file_change trigger, or default
    this.debounceMs = debounceMs ?? this.resolveDebounce();
  }

  start(): void {
    // Collect all unique watch roots from all groups' file_change triggers
    const watchPaths = new Set<string>();
    for (const config of this.configs.values()) {
      for (const trigger of config.triggers) {
        if (trigger.type === 'file_change' && trigger.match?.paths) {
          const paths = trigger.match.paths as string[];
          for (const p of paths) {
            // Extract the non-glob prefix as the watch root
            const root = p.split('*')[0];
            if (root) {
              // Ensure root ends with a path separator for clean path joining
              const normalizedRoot = root.endsWith('/') ? root : root;
              watchPaths.add(normalizedRoot);
            }
          }
        }
      }
    }

    if (watchPaths.size === 0) {
      logger.info('No file watch paths configured');
      return;
    }

    for (const watchPath of watchPaths) {
      // Verify the path exists before watching
      if (!fs.existsSync(watchPath)) {
        logger.warn({ watchPath }, 'File watch path does not exist, skipping');
        continue;
      }

      try {
        const watcher = fs.watch(
          watchPath,
          { recursive: true },
          (eventType, filename) => {
            if (!filename) return;
            const fullPath = path.join(watchPath, filename);
            this.debouncedTrigger(fullPath, eventType);
          },
        );
        this.watchers.push(watcher);
        logger.info({ watchPath }, 'File watcher started');
      } catch (err) {
        logger.error({ watchPath, err }, 'Failed to start file watcher');
      }
    }
  }

  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private debouncedTrigger(filePath: string, fsEvent: string): void {
    const existing = this.timers.get(filePath);
    if (existing) clearTimeout(existing);

    this.timers.set(
      filePath,
      setTimeout(() => {
        this.timers.delete(filePath);
        const event: IncomingEvent = {
          type: 'file_change',
          variables: {
            path: filePath,
            event: fsEvent === 'rename' ? 'created' : 'modified',
          },
          rawContent: `File ${fsEvent}: ${filePath}`,
        };
        this.router.route(event).catch((err) => {
          logger.error(
            { filePath, err },
            'Error routing file change event',
          );
        });
      }, this.debounceMs),
    );
  }

  private resolveDebounce(): number {
    let min = DEFAULT_DEBOUNCE_MS;
    for (const config of this.configs.values()) {
      for (const trigger of config.triggers) {
        if (
          trigger.type === 'file_change' &&
          trigger.debounce !== undefined &&
          trigger.debounce > 0
        ) {
          min = Math.min(min, trigger.debounce * 1000); // config is in seconds
        }
      }
    }
    return min;
  }
}
