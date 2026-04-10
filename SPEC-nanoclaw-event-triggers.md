# Event-driven agent triggers for nanoclaw

> **Repo:** https://github.com/johncarpenter/nanoclaw
> **Upstream:** https://github.com/qwibitai/nanoclaw
> **Status:** Proposed
> **Goal:** Add event-pattern routing so agents react to webhooks, email patterns, file changes, and keyword-filtered Slack messages — not just direct mentions.

## Summary

Nanoclaw currently routes messages to groups based on which channel they arrive in. This spec adds a declarative event config per group (`events.yaml`) that lets each agent define trigger patterns (email from X, webhook from Y, keyword Z in a channel, file changed at path W) with prompt templates. The event router matches incoming events against all groups' patterns and dispatches to the right container with a contextual prompt.

No new processes. No new dependencies. The event routing integrates into nanoclaw's existing single-process polling loop.

## What exists today

| Capability | How it works |
|---|---|
| Slack messages → agent | Channel membership. Message in a channel → that group's container. |
| Scheduled tasks | Cron-style. Defined in group config. Agent runs on schedule. |
| Container isolation | Each group gets its own container, `CLAUDE.md`, filesystem. |
| Message queue | Per-group queue with global concurrency limit. |
| IPC | Filesystem-based. Agent writes to mounted dir, orchestrator reads. |

## What's new

### 1. Event config per group

Each group gets an optional `events.yaml` in its directory:

```
groups/
├── content/
│   ├── CLAUDE.md           # existing — agent memory + system prompt
│   └── events.yaml         # NEW — trigger patterns + prompt templates
├── finance/
│   ├── CLAUDE.md
│   └── events.yaml
├── devops/
│   ├── CLAUDE.md
│   └── events.yaml
└── research/
    ├── CLAUDE.md
    └── events.yaml
```

### 2. Event config format

```yaml
# groups/finance/events.yaml

triggers:
  # React to emails matching a pattern
  - type: email
    match:
      from: "*@harvest.com"
    prompt: |
      A Harvest notification arrived. Here's the email:
      
      From: {{from}}
      Subject: {{subject}}
      Body: {{body}}
      
      Check if any invoices need follow-up. Post a summary in #finance.

  # React to Slack messages containing keywords (not just mentions)
  - type: slack
    match:
      channels: ["#general", "#sales"]
      keywords: ["invoice", "payment", "billing", "overdue"]
    prompt: |
      A finance-related message appeared in {{channel}}:
      
      {{user}}: {{message}}
      
      Decide if this needs action. If yes, post in #finance.

  # React to direct mentions (existing behavior, now explicit)
  - type: slack
    match:
      mention: true
      channels: ["#finance"]
    # No prompt template — pass the raw message (current default behavior)

  # React to webhooks
  - type: webhook
    match:
      path: "/hooks/stripe"
      events: ["invoice.payment_failed", "invoice.paid"]
    prompt: |
      A Stripe webhook fired:
      
      Event: {{event_type}}
      Payload: {{payload}}
      
      Update the revenue tracker in gdrive/shared/financials/.

  # React to file changes in a watched directory
  - type: file_change
    match:
      paths: ["gdrive/shared/financials/*.md"]
    debounce: 30  # seconds — don't trigger on every save during editing
    prompt: |
      The file {{path}} was modified.
      Review the changes and decide if any downstream updates are needed.

  # Scheduled tasks (already supported by nanoclaw, now co-located in events.yaml)
  - type: cron
    schedule: "0 8 1 * *"
    prompt: |
      It's the 1st of the month. Generate the monthly financial summary.
      Check Harvest for hours billed and Zoho for outstanding invoices.
      Write the summary to gdrive/shared/financials/{{year}}-{{month}}-summary.md.
      Post a brief overview in #finance.
```

### 3. Prompt templates

Templates use `{{variable}}` interpolation. Available variables depend on trigger type:

| Trigger type | Available variables |
|---|---|
| `email` | `from`, `to`, `subject`, `body`, `date`, `attachments` |
| `slack` | `user`, `channel`, `message`, `thread_ts`, `timestamp` |
| `webhook` | `path`, `method`, `event_type`, `payload`, `headers` |
| `file_change` | `path`, `event` (created/modified/deleted), `old_content`, `new_content` |
| `cron` | `year`, `month`, `day`, `weekday`, `hour`, `minute`, `timestamp` |

If no `prompt` is specified, the raw event payload is passed as the message (preserving current nanoclaw behavior for Slack mentions).

### 4. Default outputs

Each group's events.yaml can declare default output channels. The agent's `CLAUDE.md` should reference these, but the config makes them discoverable:

```yaml
outputs:
  slack: ["#finance"]
  gdrive: "shared/financials"
```

These are informational — they're injected into the agent's context as "your default output channels are..." rather than enforced programmatically. The agent decides where to write based on its `CLAUDE.md` instructions and the outputs hint.

## Implementation

### 4 changes to the nanoclaw codebase

#### Change 1: Event config loader

**File:** `src/events.ts` (new)

Load and validate `events.yaml` for each group at startup. Watch for changes and reload.

```typescript
interface TriggerConfig {
  type: 'email' | 'slack' | 'webhook' | 'file_change' | 'cron'
  match?: Record<string, any>
  prompt?: string
  debounce?: number
}

interface GroupEvents {
  triggers: TriggerConfig[]
  outputs?: {
    slack?: string[]
    gdrive?: string
  }
}

function loadGroupEvents(groupDir: string): GroupEvents | null {
  const eventsPath = path.join(groupDir, 'events.yaml')
  if (!fs.existsSync(eventsPath)) return null
  return yaml.parse(fs.readFileSync(eventsPath, 'utf-8'))
}

function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
}
```

Validation: warn on unknown trigger types, validate cron expressions, check that referenced channels exist.

#### Change 2: Event router

**File:** `src/event-router.ts` (new)

Central matcher that receives events from all sources and dispatches to the right group.

```typescript
class EventRouter {
  private groups: Map<string, GroupEvents>

  // Called by each event source
  async route(event: IncomingEvent): Promise<void> {
    for (const [groupName, config] of this.groups) {
      for (const trigger of config.triggers) {
        if (this.matches(trigger, event)) {
          const prompt = trigger.prompt
            ? renderPrompt(trigger.prompt, event.variables)
            : event.rawContent
          await this.dispatch(groupName, prompt, event)
          // Don't break — multiple groups can react to the same event
        }
      }
    }
  }

  private matches(trigger: TriggerConfig, event: IncomingEvent): boolean {
    if (trigger.type !== event.type) return false

    switch (trigger.type) {
      case 'email':
        return this.matchEmail(trigger.match, event)
      case 'slack':
        return this.matchSlack(trigger.match, event)
      case 'webhook':
        return this.matchWebhook(trigger.match, event)
      case 'file_change':
        return this.matchFileChange(trigger.match, event)
      case 'cron':
        return false // cron triggers are handled separately by scheduler
    }
  }

  private matchEmail(match: any, event: IncomingEvent): boolean {
    if (match?.from) {
      return globMatch(event.variables.from, match.from)
    }
    return true
  }

  private matchSlack(match: any, event: IncomingEvent): boolean {
    // Check channel
    if (match?.channels && !match.channels.includes(event.variables.channel)) {
      return false
    }
    // Check mention
    if (match?.mention && !event.variables.isMention) {
      return false
    }
    // Check keywords
    if (match?.keywords) {
      const msg = event.variables.message.toLowerCase()
      return match.keywords.some((kw: string) => msg.includes(kw.toLowerCase()))
    }
    return true
  }

  private matchWebhook(match: any, event: IncomingEvent): boolean {
    if (match?.path && event.variables.path !== match.path) return false
    if (match?.events && !match.events.includes(event.variables.event_type)) return false
    return true
  }

  private matchFileChange(match: any, event: IncomingEvent): boolean {
    if (match?.paths) {
      return match.paths.some((pattern: string) => globMatch(event.variables.path, pattern))
    }
    return true
  }

  private async dispatch(groupName: string, prompt: string, event: IncomingEvent) {
    // Enqueue into the existing per-group message queue
    // This uses nanoclaw's existing group-queue.ts and container-runner.ts
    await enqueueMessage(groupName, {
      content: prompt,
      source: event.type,
      metadata: event.variables,
    })
  }
}
```

The router doesn't replace nanoclaw's existing channel routing — it supplements it. Direct Slack mentions to a group's channel still work exactly as before. The router adds pattern-based triggers on top.

#### Change 3: Webhook HTTP endpoint

**File:** `src/webhooks.ts` (new)

A minimal Express (or built-in Node http) server that receives webhooks and feeds them to the event router.

```typescript
import express from 'express'

function createWebhookServer(router: EventRouter, port = 7890): express.Application {
  const app = express()
  app.use(express.json())

  // Generic webhook receiver
  // Path determines which triggers match: POST /hooks/stripe → path="/hooks/stripe"
  app.post('/hooks/:source', async (req, res) => {
    const event: IncomingEvent = {
      type: 'webhook',
      variables: {
        path: `/hooks/${req.params.source}`,
        method: 'POST',
        event_type: req.body?.type ?? req.headers['x-github-event'] ?? 'unknown',
        payload: JSON.stringify(req.body, null, 2),
        headers: JSON.stringify(req.headers),
      },
      rawContent: JSON.stringify(req.body, null, 2),
    }
    await router.route(event)
    res.status(200).json({ ok: true })
  })

  // Health check
  app.get('/health', (_, res) => res.json({ status: 'ok' }))

  app.listen(port, () => {
    console.log(`Webhook listener on :${port}`)
  })

  return app
}
```

For local development, this just runs on localhost. For production, expose via Cloudflare Tunnel, ngrok, or a reverse proxy. GitHub/Stripe/etc webhook configs point to this endpoint.

**Security:** Webhook signature verification should be added per source. GitHub sends `X-Hub-Signature-256`, Stripe sends `Stripe-Signature`. The webhook handler should validate these before routing. Start without it (since it's running locally behind a tunnel), add per-source verification as a follow-up.

#### Change 4: File watcher

**File:** `src/file-watcher.ts` (new)

Watches configured paths and triggers events with debouncing.

```typescript
import { watch } from 'fs'
import { globMatch } from './utils'

class FileWatcher {
  private timers: Map<string, NodeJS.Timeout> = new Map()

  constructor(private router: EventRouter, private configs: Map<string, GroupEvents>) {}

  start() {
    // Collect all unique watch roots from all groups' file_change triggers
    const watchPaths = new Set<string>()
    for (const [_, config] of this.configs) {
      for (const trigger of config.triggers) {
        if (trigger.type === 'file_change' && trigger.match?.paths) {
          for (const p of trigger.match.paths) {
            // Extract the non-glob prefix as the watch root
            const root = p.split('*')[0]
            watchPaths.add(root)
          }
        }
      }
    }

    for (const watchPath of watchPaths) {
      watch(watchPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return
        const fullPath = `${watchPath}${filename}`
        this.debouncedTrigger(fullPath, eventType)
      })
    }
  }

  private debouncedTrigger(path: string, fsEvent: string) {
    const existing = this.timers.get(path)
    if (existing) clearTimeout(existing)

    // Default 30s debounce — prevents triggering on every keystroke during editing
    this.timers.set(path, setTimeout(() => {
      this.timers.delete(path)
      this.router.route({
        type: 'file_change',
        variables: {
          path,
          event: fsEvent === 'rename' ? 'created' : 'modified',
        },
        rawContent: `File ${fsEvent}: ${path}`,
      })
    }, 30_000))
  }
}
```

### Integration with existing nanoclaw code

The four new files integrate into `src/index.ts` (the orchestrator) at startup:

```typescript
// In src/index.ts — after existing initialization

// Load event configs for all groups
const groupEvents = loadAllGroupEvents(groupsDir)

// Create event router
const eventRouter = new EventRouter(groupEvents)

// Wire email events through the router (supplement existing Gmail channel)
// The existing Gmail channel adapter calls eventRouter.route() for each email
// instead of (or in addition to) directly enqueuing to a group

// Start webhook server
if (hasWebhookTriggers(groupEvents)) {
  createWebhookServer(eventRouter, config.webhookPort ?? 7890)
}

// Start file watcher
if (hasFileChangeTriggers(groupEvents)) {
  const watcher = new FileWatcher(eventRouter, groupEvents)
  watcher.start()
}

// Cron triggers from events.yaml merge with existing scheduled tasks
for (const [group, events] of groupEvents) {
  for (const trigger of events.triggers) {
    if (trigger.type === 'cron') {
      scheduler.add({
        group,
        schedule: trigger.schedule,
        prompt: renderPrompt(trigger.prompt, cronVars()),
      })
    }
  }
}
```

The key principle: **the event router enqueues messages into the existing per-group message queue.** It doesn't bypass the container runner, concurrency control, or any other nanoclaw infrastructure. It's just a new way for messages to arrive.

### Slack keyword matching

The existing Slack channel adapter needs a small modification. Currently it routes messages based on channel membership. With keyword triggers, it also needs to:

1. For each incoming Slack message, check all groups' `events.yaml` for `type: slack` triggers with `keywords`
2. If a keyword matches, enqueue the message to that group with the rendered prompt template
3. The existing direct-mention routing continues to work unchanged

This is a ~20 line change in the existing Slack channel handler, not a new file.

## Example: setting up a four-agent company

```bash
# Fork and setup
gh repo clone johncarpenter/nanoclaw
cd nanoclaw
claude
/setup
/add-slack
/add-gmail
```

Then create four groups:

```bash
# In Claude Code:
# "Create groups for content, finance, devops, and research"
# Claude creates the directories and CLAUDE.md files

# Or manually:
mkdir -p groups/{content,finance,devops,research}
```

Write each agent's `CLAUDE.md`:

```markdown
# groups/content/CLAUDE.md

You are the content agent for 2 Lines Software / Discontinuity.ai.

## Responsibilities
- Draft blog posts for Substack and LinkedIn
- Follow the editorial calendar in gdrive/shared/content-calendar.md
- Write drafts to gdrive/shared/content-drafts/
- Post status updates in #content

## Voice
- Technical but accessible
- First person, conversational
- No buzzwords

## Current projects
- Weekly Substack on AI/SaaS economics
- LinkedIn thought leadership (2x/week)

## When triggered
1. Read your previous notes below for context
2. Check the content calendar for what's due
3. Do the work
4. Update your notes below with what you did and what's next

---
## Agent notes (updated by you each session)
_No notes yet. First session pending._
```

Write each agent's `events.yaml` (examples shown earlier in this spec).

Set up shared GDrive folder:

```
~/gdrive/shared/
├── content-calendar.md
├── content-drafts/
├── financials/
└── engineering/
```

Mount it into nanoclaw so agents can access it:

```bash
# In nanoclaw config, add the shared GDrive-synced folder as a mount
# for all groups that need it
```

Create Slack channels: `#content`, `#finance`, `#engineering`, `#research`.

Start nanoclaw:

```bash
npm start
```

That's it. The agents are now live, responding to events. You interact via Slack. You edit files in GDrive. Everything is on your laptop.

## What this doesn't include (intentionally)

- **Inter-agent communication protocol** — agents don't talk to each other. They write to shared locations. Other agents read those locations when they're next triggered. This is a feature, not a limitation.
- **Orchestrator agent** — no agent coordinates the others. Events trigger agents independently. If you want a "Monday morning review" that synthesizes across agents, that's just another agent with a cron trigger whose prompt says "read the status files from all agents in gdrive/shared/ and write a summary."
- **Custom runboard CLI** — nanoclaw's existing CLI and Claude Code skills handle agent management. Adding `events.yaml` doesn't require new CLI commands. If you want `runboard trigger finance "Check Q2"` that's just a convenience wrapper around injecting a message into a group's queue.
- **Remote deployment** — this runs locally. If you want remote later, containerize the whole nanoclaw instance (it's already a single Node process with Docker containers) and run it on a VM.

## Migration path

| Phase | What | Effort |
|---|---|---|
| 1 | Fork nanoclaw, `/setup`, `/add-slack`, `/add-gmail`, create groups with `CLAUDE.md` files | 1 day |
| 2 | Add event config loader + router + Slack keyword matching | 1-2 days |
| 3 | Add webhook endpoint | Half day |
| 4 | Add file watcher | Half day |
| 5 | Write actual agent `CLAUDE.md` and `events.yaml` for your roster | 1 day |
| 6 | Test, iterate on prompts, tune trigger patterns | Ongoing |

Total to a working "company in a box": about a week, most of which is writing good agent prompts.

## Contributing back upstream

If the community wants this, the changes are modular enough to contribute as:

1. **A nanoclaw skill** (`/add-event-triggers`) — Claude Code applies the code changes to any fork
2. **A PR to upstream** — four new files, ~20 lines changed in existing code, zero breaking changes

The skill approach fits nanoclaw's philosophy better. The event config is opt-in (groups without `events.yaml` work exactly as before), so it doesn't add complexity for users who don't want it.
