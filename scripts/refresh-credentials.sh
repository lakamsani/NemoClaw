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

SANDBOX="${1:-${NEMOCLAW_SANDBOX:-veyonce-claw}}"
SSH_CONF="/tmp/ssh-config-${SANDBOX}"

# Refresh SSH config
openshell sandbox ssh-config "$SANDBOX" > "$SSH_CONF" 2>/dev/null || exit 0

ssh_cmd() {
  ssh -F "$SSH_CONF" -o StrictHostKeyChecking=no -o ConnectTimeout=5 "openshell-${SANDBOX}" "$@"
}

# Check sandbox is reachable
ssh_cmd 'true' 2>/dev/null || exit 0

# Re-inject Claude credentials
if [ -f "$HOME/.claude/.credentials.json" ]; then
  base64 "$HOME/.claude/.credentials.json" | ssh_cmd 'base64 -d > /sandbox/.claude/.credentials.json && chmod 600 /sandbox/.claude/.credentials.json'

  # Extract and patch ANTHROPIC_API_KEY
  ANTHROPIC_API_KEY="$(python3 -c "import json; d=json.load(open('$HOME/.claude/.credentials.json')); print(d.get('claudeAiOauth',{}).get('accessToken',''))" 2>/dev/null || true)"

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

  echo "[refresh] Claude credentials updated for $SANDBOX ($(date))"
fi

# Re-inject GOG_KEYRING_PASSWORD (for headless gog auth)
GOG_KEYRING_PW="${GOG_KEYRING_PASSWORD:-nemoclaw}"
ssh_cmd "grep -q GOG_KEYRING_PASSWORD /sandbox/.env 2>/dev/null && sed -i 's|^GOG_KEYRING_PASSWORD=.*|GOG_KEYRING_PASSWORD=${GOG_KEYRING_PW}|' /sandbox/.env || echo 'GOG_KEYRING_PASSWORD=${GOG_KEYRING_PW}' >> /sandbox/.env; chmod 600 /sandbox/.env" 2>/dev/null

# Re-inject Slack webhook URL
if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  ssh_cmd "grep -q SLACK_WEBHOOK_URL /sandbox/.env 2>/dev/null && sed -i 's|^SLACK_WEBHOOK_URL=.*|SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}|' /sandbox/.env || echo 'SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}' >> /sandbox/.env; chmod 600 /sandbox/.env" 2>/dev/null
fi

# Re-inject MCP auth cache
if [ -f "$HOME/.claude/mcp-needs-auth-cache.json" ]; then
  base64 "$HOME/.claude/mcp-needs-auth-cache.json" | ssh_cmd 'base64 -d > /sandbox/.claude/mcp-needs-auth-cache.json && chmod 600 /sandbox/.claude/mcp-needs-auth-cache.json'
fi
