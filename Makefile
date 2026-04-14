# NanoClaw Remote Management
# Syncs code, agents, credentials, and config to Mac Mini
#
# Usage:
#   make deploy          — full sync (code + agents + config + sessions)
#   make sync-agents     — sync nanoclaw-agents data only
#   make sync-creds      — sync OAuth/auth credentials
#   make sync-config     — sync .env, mount-allowlist, sessions
#   make sync-db         — sync SQLite database
#   make restart         — restart NanoClaw on remote
#   make logs            — tail remote logs
#   make status          — check remote service status
#   make ssh             — open SSH session to remote

# ── Remote host config ──────────────────────────────────────────────
REMOTE_HOST    := skywalker@skywalker.local
REMOTE_HOME    := /Users/skywalker
REMOTE_NANOCLAW := $(REMOTE_HOME)/nanoclaw
REMOTE_AGENTS  := $(REMOTE_HOME)/nanoclaw-agents

# ── Local paths ─────────────────────────────────────────────────────
LOCAL_NANOCLAW := $(shell pwd)
LOCAL_AGENTS   := $(shell dirname $(LOCAL_NANOCLAW))/nanoclaw-agents

# ── Rsync defaults ──────────────────────────────────────────────────
RSYNC := rsync -az --delete
RSYNC_EXCLUDE := --exclude='node_modules' --exclude='.DS_Store' --exclude='.venv' --exclude='__pycache__' --exclude='.git'

# ── Full deploy ─────────────────────────────────────────────────────
.PHONY: deploy
deploy: sync-agents sync-config sync-creds sync-sessions build-remote restart
	@echo "✓ Full deploy complete"

# ── Sync nanoclaw-agents (skills, data, MCPs) ──────────────────────
.PHONY: sync-agents
sync-agents:
	@echo "Syncing nanoclaw-agents..."
	$(RSYNC) $(RSYNC_EXCLUDE) \
		$(LOCAL_AGENTS)/ $(REMOTE_HOST):$(REMOTE_AGENTS)/
	@echo "✓ Agents synced"

# ── Sync OAuth/auth credentials ─────────────────────────────────────
.PHONY: sync-creds
sync-creds: sync-creds-gmail sync-creds-garmin sync-creds-strava
	@echo "✓ All credentials synced"

.PHONY: sync-creds-gmail
sync-creds-gmail:
	@echo "Syncing Gmail OAuth credentials..."
	rsync -az ~/.gmail-mcp/ $(REMOTE_HOST):$(REMOTE_HOME)/.gmail-mcp/
	@echo "✓ Gmail credentials synced"

.PHONY: sync-creds-garmin
sync-creds-garmin:
	@echo "Syncing Garmin credentials..."
	rsync -az ~/.garminconnect/ $(REMOTE_HOST):$(REMOTE_HOME)/.garminconnect/
	@echo "✓ Garmin credentials synced"

.PHONY: sync-creds-strava
sync-creds-strava:
	@echo "Syncing Strava credentials..."
	rsync -az ~/.config/strava-mcp/ $(REMOTE_HOST):$(REMOTE_HOME)/.config/strava-mcp/
	@echo "✓ Strava credentials synced"

# ── Sync config (.env, mount-allowlist) ─────────────────────────────
.PHONY: sync-config
sync-config:
	@echo "Syncing config files..."
	scp -q $(LOCAL_NANOCLAW)/.env $(REMOTE_HOST):$(REMOTE_NANOCLAW)/.env
	scp -q ~/.config/nanoclaw/mount-allowlist.json \
		$(REMOTE_HOST):$(REMOTE_HOME)/.config/nanoclaw/mount-allowlist.json
	@echo "✓ Config synced"
	@echo "⚠  Remember: GROUPS_DIR path differs on remote — verify .env"

# ── Sync session configs (MCP settings per group) ──────────────────
.PHONY: sync-sessions
sync-sessions:
	@echo "Syncing session configs..."
	$(RSYNC) $(LOCAL_NANOCLAW)/data/sessions/ \
		$(REMOTE_HOST):$(REMOTE_NANOCLAW)/data/sessions/
	@echo "✓ Session configs synced"

# ── Sync SQLite database ───────────────────────────────────────────
# ⚠  Only do this when remote is stopped — SQLite doesn't like
#    being overwritten while in use
.PHONY: sync-db
sync-db:
	@echo "⚠  Stopping remote NanoClaw before DB sync..."
	ssh $(REMOTE_HOST) "launchctl kickstart -k gui/\$$(id -u)/com.nanoclaw 2>/dev/null; sleep 1" || true
	scp -q $(LOCAL_NANOCLAW)/store/messages.db \
		$(REMOTE_HOST):$(REMOTE_NANOCLAW)/store/messages.db
	@echo "✓ Database synced — restarting remote..."
	ssh $(REMOTE_HOST) "launchctl kickstart -k gui/\$$(id -u)/com.nanoclaw"

# ── Build on remote ────────────────────────────────────────────────
.PHONY: build-remote
build-remote:
	@echo "Building on remote..."
	ssh $(REMOTE_HOST) "cd $(REMOTE_NANOCLAW) && git pull && npm install && npm run build"
	@echo "✓ Remote build complete"

# ── Rebuild container image on remote ──────────────────────────────
.PHONY: build-container
build-container:
	@echo "Rebuilding agent container on remote..."
	ssh $(REMOTE_HOST) "cd $(REMOTE_NANOCLAW) && ./container/build.sh"
	@echo "✓ Container image rebuilt"

# ── Restart NanoClaw on remote ──────────────────────────────────────
.PHONY: restart
restart:
	@echo "Restarting NanoClaw on remote..."
	ssh $(REMOTE_HOST) "launchctl kickstart -k gui/\$$(id -u)/com.nanoclaw"
	@echo "✓ Restarted"

# ── Stop NanoClaw on remote ─────────────────────────────────────────
.PHONY: stop
stop:
	ssh $(REMOTE_HOST) "launchctl bootout gui/\$$(id -u)/com.nanoclaw 2>/dev/null" || true
	@echo "✓ Stopped"

# ── Start NanoClaw on remote ────────────────────────────────────────
.PHONY: start
start:
	ssh $(REMOTE_HOST) "launchctl bootstrap gui/\$$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist"
	@echo "✓ Started"

# ── Clear a group session (forces fresh container on next message) ──
.PHONY: reset-session
reset-session:
ifndef GROUP
	@echo "Usage: make reset-session GROUP=knowledge-worker"
	@exit 1
endif
	ssh $(REMOTE_HOST) "sqlite3 $(REMOTE_NANOCLAW)/store/messages.db \"DELETE FROM sessions WHERE group_folder = '$(GROUP)';\""
	ssh $(REMOTE_HOST) "docker ps --filter 'name=nanoclaw-$(GROUP)' -q | xargs -r docker stop 2>/dev/null" || true
	@echo "✓ Session reset for $(GROUP)"

# ── Tail remote logs ────────────────────────────────────────────────
.PHONY: logs
logs:
	ssh -t $(REMOTE_HOST) "tail -f $(REMOTE_NANOCLAW)/logs/nanoclaw.log"

.PHONY: logs-error
logs-error:
	ssh -t $(REMOTE_HOST) "tail -f $(REMOTE_NANOCLAW)/logs/nanoclaw.error.log"

# ── Check remote status ────────────────────────────────────────────
.PHONY: status
status:
	@echo "── Service ──"
	@ssh $(REMOTE_HOST) "launchctl print gui/\$$(id -u)/com.nanoclaw 2>&1 | grep -E 'state|runs|last exit|active count'" || echo "  Not loaded"
	@echo ""
	@echo "── Containers ──"
	@ssh $(REMOTE_HOST) "docker ps --filter 'name=nanoclaw-' --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}'" || echo "  None running"
	@echo ""
	@echo "── Groups ──"
	@ssh $(REMOTE_HOST) "sqlite3 $(REMOTE_NANOCLAW)/store/messages.db \"SELECT folder, name FROM registered_groups ORDER BY folder;\""

# ── SSH into remote ─────────────────────────────────────────────────
.PHONY: ssh
ssh:
	ssh $(REMOTE_HOST)

# ── Help ────────────────────────────────────────────────────────────
.PHONY: help
help:
	@echo "NanoClaw Remote Management"
	@echo ""
	@echo "  make deploy              Full sync + build + restart"
	@echo "  make sync-agents         Sync nanoclaw-agents (skills, data, MCPs)"
	@echo "  make sync-creds          Sync all OAuth/auth credentials"
	@echo "  make sync-creds-gmail    Sync Gmail credentials only"
	@echo "  make sync-creds-garmin   Sync Garmin credentials only"
	@echo "  make sync-creds-strava   Sync Strava credentials only"
	@echo "  make sync-config         Sync .env and mount-allowlist"
	@echo "  make sync-sessions       Sync MCP session configs"
	@echo "  make sync-db             Sync SQLite DB (stops remote first)"
	@echo "  make build-remote        Pull, install, build on remote"
	@echo "  make build-container     Rebuild agent container on remote"
	@echo "  make restart             Restart NanoClaw on remote"
	@echo "  make stop                Stop NanoClaw on remote"
	@echo "  make start               Start NanoClaw on remote"
	@echo "  make reset-session GROUP=name  Clear session for a group"
	@echo "  make logs                Tail remote logs"
	@echo "  make logs-error          Tail remote error logs"
	@echo "  make status              Check remote service + containers"
	@echo "  make ssh                 Open SSH session"
