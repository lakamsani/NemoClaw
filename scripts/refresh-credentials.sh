#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Lightweight credential refresh — re-injects Claude OAuth token and patches
# ANTHROPIC_API_KEY in openclaw.json. Run on a cron every 4 hours.
#
# Usage: ./scripts/refresh-credentials.sh [sandbox-name]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$REPO_DIR/.env" ]; then
  set -a; . "$REPO_DIR/.env"; set +a
fi

# Parse arguments
SANDBOX=""
CRED_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --cred-dir) CRED_DIR="${2:?--cred-dir requires a path}"; shift 2 ;;
    -*) shift ;;
    *)
      # First positional arg is sandbox name
      if [ -z "$SANDBOX" ]; then
        SANDBOX="$1"
      fi
      shift
      ;;
  esac
done

SANDBOX="${SANDBOX:-${NEMOCLAW_SANDBOX:-veyonce-claw}}"
SSH_CONF="/tmp/ssh-config-${SANDBOX}"

# Resolve relative cred dir to absolute
if [ -n "$CRED_DIR" ] && [[ "$CRED_DIR" != /* ]]; then
  CRED_DIR="$REPO_DIR/$CRED_DIR"
fi

# Refresh SSH config
openshell sandbox ssh-config "$SANDBOX" > "$SSH_CONF" 2>/dev/null || exit 0

ssh_cmd() {
  ssh -F "$SSH_CONF" -o StrictHostKeyChecking=no -o ConnectTimeout=5 "openshell-${SANDBOX}" "$@"
}

# Check sandbox is reachable
ssh_cmd 'true' 2>/dev/null || exit 0

# Re-inject Claude credentials (per-user dir first, then host default)
CLAUDE_CREDS=""
if [ -n "$CRED_DIR" ] && [ -f "$CRED_DIR/claude-credentials.json" ]; then
  CLAUDE_CREDS="$CRED_DIR/claude-credentials.json"
elif [ -f "$HOME/.claude/.credentials.json" ]; then
  CLAUDE_CREDS="$HOME/.claude/.credentials.json"
fi

if [ -n "$CLAUDE_CREDS" ]; then
  base64 "$CLAUDE_CREDS" | ssh_cmd 'base64 -d > /sandbox/.claude/.credentials.json && chmod 600 /sandbox/.claude/.credentials.json'

  # Extract and patch ANTHROPIC_API_KEY
  ANTHROPIC_API_KEY="$(python3 -c "import json; d=json.load(open('$CLAUDE_CREDS')); print(d.get('claudeAiOauth',{}).get('accessToken',''))" 2>/dev/null || true)"

  if [ -n "$ANTHROPIC_API_KEY" ]; then
    ssh_cmd "python3 -c \"
import json, os
path = os.path.expanduser('~/.openclaw/openclaw.json')
cfg = json.load(open(path))
p = cfg.get('models',{}).get('providers',{}).get('anthropic',{})
if p:
    p['apiKey'] = '${ANTHROPIC_API_KEY}'
    json.dump(cfg, open(path, 'w'), indent=2)
    os.chmod(path, 0o600)
\"" 2>/dev/null
  fi

  # Restore device pairing (required for CLI → gateway communication)
  PAIRED_FILE="$REPO_DIR/persist/gateway/paired.json"
  if [ -f "$PAIRED_FILE" ]; then
    ssh_cmd 'mkdir -p /sandbox/.openclaw/devices'
    base64 "$PAIRED_FILE" | ssh_cmd 'base64 -d > /sandbox/.openclaw/devices/paired.json && chmod 600 /sandbox/.openclaw/devices/paired.json'
  fi

  # Restart gateway so it picks up the new token (it caches apiKey in memory)
  ssh_cmd 'export HOME=/sandbox; node -e "
const fs = require(\"fs\");
const dirs = fs.readdirSync(\"/proc\").filter(d => /^\\d+\$/.test(d));
for (const pid of dirs) {
  try {
    const cmd = fs.readFileSync(\"/proc/\" + pid + \"/cmdline\", \"utf8\");
    if (cmd.includes(\"gateway\") && cmd.includes(\"openclaw\")) {
      process.kill(Number(pid), 9);
    }
  } catch(e) {}
}
"' 2>/dev/null || true
  sleep 2
  # Start gateway in a separate SSH session that stays alive
  ssh -F "$SSH_CONF" -o StrictHostKeyChecking=no -o ConnectTimeout=5 "openshell-${SANDBOX}" \
    'export HOME=/sandbox; openclaw gateway run >> /tmp/gateway.log 2>&1' </dev/null &
  sleep 5
  ssh_cmd 'export HOME=/sandbox; openclaw gateway call health > /dev/null 2>&1' 2>/dev/null || true

  echo "[refresh] Claude credentials updated for $SANDBOX from $CLAUDE_CREDS ($(date))"
fi

# Re-inject Anthropic API key if stored separately (per-user)
ANTHROPIC_KEY_FILE=""
if [ -n "$CRED_DIR" ] && [ -f "$CRED_DIR/anthropic-key.txt" ]; then
  ANTHROPIC_KEY_FILE="$CRED_DIR/anthropic-key.txt"
fi
if [ -n "$ANTHROPIC_KEY_FILE" ]; then
  ANTHRO_KEY="$(cat "$ANTHROPIC_KEY_FILE")"
  ssh_cmd "grep -q ANTHROPIC_API_KEY /sandbox/.env 2>/dev/null && sed -i 's|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${ANTHRO_KEY}|' /sandbox/.env || echo 'ANTHROPIC_API_KEY=${ANTHRO_KEY}' >> /sandbox/.env; chmod 600 /sandbox/.env" 2>/dev/null
  echo "[refresh] Anthropic API key refreshed for $SANDBOX ($(date))"
fi

# Re-inject GOG_KEYRING_PASSWORD (for headless gog auth)
GOG_KEYRING_PW="${GOG_KEYRING_PASSWORD:-nemoclaw}"
ssh_cmd "grep -q GOG_KEYRING_PASSWORD /sandbox/.env 2>/dev/null && sed -i 's|^GOG_KEYRING_PASSWORD=.*|GOG_KEYRING_PASSWORD=${GOG_KEYRING_PW}|' /sandbox/.env || echo 'GOG_KEYRING_PASSWORD=${GOG_KEYRING_PW}' >> /sandbox/.env; chmod 600 /sandbox/.env" 2>/dev/null

# Re-inject Slack bot token (for heartbeat DMs)
if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
  ssh_cmd "grep -q SLACK_BOT_TOKEN /sandbox/.env 2>/dev/null && sed -i 's|^SLACK_BOT_TOKEN=.*|SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}|' /sandbox/.env || echo 'SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}' >> /sandbox/.env; chmod 600 /sandbox/.env" 2>/dev/null
fi

# Re-inject Slack webhook URL
if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  ssh_cmd "grep -q SLACK_WEBHOOK_URL /sandbox/.env 2>/dev/null && sed -i 's|^SLACK_WEBHOOK_URL=.*|SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}|' /sandbox/.env || echo 'SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}' >> /sandbox/.env; chmod 600 /sandbox/.env" 2>/dev/null
fi

# Re-inject MCP auth cache (per-user dir first, then host default)
MCP_CACHE=""
if [ -n "$CRED_DIR" ] && [ -f "$CRED_DIR/mcp-needs-auth-cache.json" ]; then
  MCP_CACHE="$CRED_DIR/mcp-needs-auth-cache.json"
elif [ -f "$HOME/.claude/mcp-needs-auth-cache.json" ]; then
  MCP_CACHE="$HOME/.claude/mcp-needs-auth-cache.json"
fi
if [ -n "$MCP_CACHE" ]; then
  base64 "$MCP_CACHE" | ssh_cmd 'base64 -d > /sandbox/.claude/mcp-needs-auth-cache.json && chmod 600 /sandbox/.claude/mcp-needs-auth-cache.json'
fi
