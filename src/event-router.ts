import { ChildProcess } from 'child_process';

import { ASSISTANT_NAME } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  deleteSession,
  getAllSessions,
  setSession,
} from './db.js';
import {
  globMatch,
  GroupEvents,
  IncomingEvent,
  renderPrompt,
  TriggerConfig,
} from './events.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { formatOutbound } from './router.js';
import { Channel, RegisteredGroup } from './types.js';

export interface EventRouterDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  queue: GroupQueue;
  channels: Channel[];
  findChannel: (channels: Channel[], jid: string) => Channel | undefined;
  getSessions: () => Record<string, string>;
  setSessions: (folder: string, sessionId: string) => void;
}

export class EventRouter {
  private groupEvents: Map<string, GroupEvents>;
  private deps: EventRouterDeps;

  constructor(groupEvents: Map<string, GroupEvents>, deps: EventRouterDeps) {
    this.groupEvents = groupEvents;
    this.deps = deps;
  }

  updateGroupEvents(groupEvents: Map<string, GroupEvents>): void {
    this.groupEvents = groupEvents;
  }

  async route(event: IncomingEvent): Promise<void> {
    for (const [groupFolder, config] of this.groupEvents) {
      for (const trigger of config.triggers) {
        if (this.matches(trigger, event)) {
          const prompt = trigger.prompt
            ? renderPrompt(trigger.prompt, event.variables)
            : event.rawContent;

          // Inject outputs hint into prompt context
          const outputsHint = config.outputs
            ? this.buildOutputsHint(config.outputs)
            : '';
          const fullPrompt = outputsHint
            ? `${prompt}\n\n${outputsHint}`
            : prompt;

          await this.dispatch(groupFolder, fullPrompt, event);
          // Don't break — multiple groups can react to the same event
        }
      }
    }
  }

  private matches(trigger: TriggerConfig, event: IncomingEvent): boolean {
    if (trigger.type !== event.type) return false;

    switch (trigger.type) {
      case 'email':
        return this.matchEmail(trigger.match, event);
      case 'slack':
        return this.matchSlack(trigger.match, event);
      case 'webhook':
        return this.matchWebhook(trigger.match, event);
      case 'file_change':
        return this.matchFileChange(trigger.match, event);
      case 'cron':
        return false; // cron triggers handled by scheduler
    }
  }

  private matchEmail(
    match: Record<string, unknown> | undefined,
    event: IncomingEvent,
  ): boolean {
    if (match?.from) {
      return globMatch(event.variables.from || '', match.from as string);
    }
    return true;
  }

  private matchSlack(
    match: Record<string, unknown> | undefined,
    event: IncomingEvent,
  ): boolean {
    // Check channel
    if (match?.channels) {
      const channels = match.channels as string[];
      if (!channels.includes(event.variables.channel)) {
        return false;
      }
    }
    // Check mention
    if (match?.mention && !event.variables.isMention) {
      return false;
    }
    // Check keywords
    if (match?.keywords) {
      const msg = (event.variables.message || '').toLowerCase();
      const keywords = match.keywords as string[];
      return keywords.some((kw) => msg.includes(kw.toLowerCase()));
    }
    return true;
  }

  private matchWebhook(
    match: Record<string, unknown> | undefined,
    event: IncomingEvent,
  ): boolean {
    if (match?.path && event.variables.path !== match.path) return false;
    if (match?.events) {
      const events = match.events as string[];
      if (!events.includes(event.variables.event_type)) return false;
    }
    return true;
  }

  private matchFileChange(
    match: Record<string, unknown> | undefined,
    event: IncomingEvent,
  ): boolean {
    if (match?.paths) {
      const patterns = match.paths as string[];
      return patterns.some((pattern) =>
        globMatch(event.variables.path || '', pattern),
      );
    }
    return true;
  }

  private buildOutputsHint(outputs: GroupEvents['outputs']): string {
    const parts: string[] = [];
    if (outputs?.slack?.length) {
      parts.push(
        `Your default Slack output channels: ${outputs.slack.join(', ')}`,
      );
    }
    if (outputs?.gdrive) {
      parts.push(`Your default GDrive output path: ${outputs.gdrive}`);
    }
    return parts.length > 0
      ? `[Event trigger context: ${parts.join('. ')}]`
      : '';
  }

  private async dispatch(
    groupFolder: string,
    prompt: string,
    event: IncomingEvent,
  ): Promise<void> {
    const groups = this.deps.registeredGroups();

    // Find JID for this group folder
    const entry = Object.entries(groups).find(
      ([_, g]) => g.folder === groupFolder,
    );
    if (!entry) {
      logger.warn(
        { groupFolder, eventType: event.type },
        'No registered group found for event trigger, skipping',
      );
      return;
    }

    const [groupJid, group] = entry;
    const taskId = `event-${event.type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    logger.info(
      { groupFolder, eventType: event.type, taskId },
      'Dispatching event trigger',
    );

    this.deps.queue.enqueueTask(groupJid, taskId, async () => {
      await this.runEventAgent(group, groupJid, prompt, taskId);
    });
  }

  private async runEventAgent(
    group: RegisteredGroup,
    chatJid: string,
    prompt: string,
    taskId: string,
  ): Promise<void> {
    const isMain = group.isMain === true;
    const sessions = this.deps.getSessions();
    const sessionId = sessions[group.folder];

    // Write tasks snapshot for container
    const tasks = getAllTasks();
    writeTasksSnapshot(
      group.folder,
      isMain,
      tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    );

    const channel = this.deps.findChannel(this.deps.channels, chatJid);

    // Close container promptly after result (same pattern as task-scheduler)
    const CLOSE_DELAY_MS = 10_000;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleClose = () => {
      if (closeTimer) return;
      closeTimer = setTimeout(() => {
        this.deps.queue.closeStdin(chatJid);
      }, CLOSE_DELAY_MS);
    };

    try {
      const output = await runContainerAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          isMain,
          isScheduledTask: true, // event triggers behave like tasks (single-turn)
          assistantName: ASSISTANT_NAME,
        },
        (proc, containerName) =>
          this.deps.queue.registerProcess(
            chatJid,
            proc,
            containerName,
            group.folder,
          ),
        async (streamedOutput: ContainerOutput) => {
          if (streamedOutput.newSessionId) {
            this.deps.setSessions(group.folder, streamedOutput.newSessionId);
          }
          if (streamedOutput.result && channel) {
            const text = formatOutbound(streamedOutput.result);
            if (text) await channel.sendMessage(chatJid, text);
            scheduleClose();
          }
          if (streamedOutput.status === 'success') {
            this.deps.queue.notifyIdle(chatJid);
            scheduleClose();
          }
          if (streamedOutput.status === 'error') {
            logger.error(
              { taskId, error: streamedOutput.error },
              'Event agent error',
            );
          }
        },
      );

      if (closeTimer) clearTimeout(closeTimer);

      if (output.newSessionId) {
        this.deps.setSessions(group.folder, output.newSessionId);
      }

      if (output.status === 'error') {
        // Detect stale session — clear for next attempt
        const isStaleSession =
          sessionId &&
          output.error &&
          /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
            output.error,
          );
        if (isStaleSession) {
          logger.warn(
            { group: group.name, staleSessionId: sessionId },
            'Stale session detected — clearing',
          );
          deleteSession(group.folder);
        }
        logger.error(
          { taskId, error: output.error },
          'Event agent container error',
        );
      }
    } catch (err) {
      if (closeTimer) clearTimeout(closeTimer);
      logger.error({ taskId, err }, 'Event agent failed');
    }
  }
}
