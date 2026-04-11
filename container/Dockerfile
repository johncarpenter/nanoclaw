# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install uv (Python package manager, provides uvx for MCP servers)
ENV UV_INSTALL_DIR="/usr/local/bin"
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

# Pre-install garmin-mcp into a venv so it works offline at runtime (no git fetch through proxy)
RUN uv venv --python 3.11 /opt/garmin-mcp-venv \
    && GIT_SSL_NO_VERIFY=1 uv pip install --python /opt/garmin-mcp-venv/bin/python \
       "garmin-mcp @ git+https://github.com/Taxuspt/garmin_mcp" \
    && chmod -R a+rX /opt/garmin-mcp-venv

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser, claude-code, and common MCP servers globally
RUN npm install -g agent-browser @anthropic-ai/claude-code @sockeye44/better-memory-mcp

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\n# Symlink extra mounts that need specific home directory locations\n[ -d /workspace/extra/.garminconnect ] && ln -sfn /workspace/extra/.garminconnect /home/node/.garminconnect\n[ -d /workspace/extra/strava-mcp ] && mkdir -p /home/node/.config && ln -sfn /workspace/extra/strava-mcp /home/node/.config/strava-mcp\n[ -d /workspace/extra/.gmail-mcp ] && ln -sfn /workspace/extra/.gmail-mcp /home/node/.gmail-mcp\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
