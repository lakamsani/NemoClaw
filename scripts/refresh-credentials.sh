#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Lightweight credential refresh — proactively refreshes the Claude OAuth token
# (if expiring soon) and re-injects it into the sandbox's openclaw.json.
# Run on a cron every 30 minutes.
#
# Usage: ./scripts/refresh-credentials.sh [sandbox-name]

set -uo pipefail
# Note: -e intentionally omitted — individual SSH commands may fail transiently
# (e.g. during gateway restart) and we want to continue refreshing remaining steps.

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

USER_ENV_FILE=""
if [ -n "$CRED_DIR" ]; then
  USER_ENV_FILE="$(dirname "$CRED_DIR")/.env"
fi

# ── Proactive OAuth token refresh ─────────────────────────────────
# Check if the host's Claude OAuth access token expires within 90 minutes.
# If so, run a lightweight `claude -p` command which triggers Claude Code's
# built-in token refresh, then copy the refreshed credentials to the per-user
# cred dir (if applicable).
REFRESH_THRESHOLD_MS=5400000  # 90 minutes in milliseconds
HOST_CREDS="$HOME/.claude/.credentials.json"

# Only skip OAuth refresh if ANTHROPIC_API_KEY is a real long-lived API key
# (sk-ant-api...). OAuth access tokens (sk-ant-oat...) expire and need refresh.
# Any other format (e.g. stale/invalid keys) should not block OAuth refresh.
IS_LONG_LIVED_KEY=false
if [ -n "${ANTHROPIC_API_KEY:-}" ] && [[ "${ANTHROPIC_API_KEY}" == sk-ant-api* ]]; then
  IS_LONG_LIVED_KEY=true
fi

if [ "$IS_LONG_LIVED_KEY" = "false" ] && [ -f "$HOST_CREDS" ]; then
  NEEDS_REFRESH=$(python3 -c "
import json, time, sys
try:
    d = json.load(open('$HOST_CREDS'))
    exp = d.get('claudeAiOauth', {}).get('expiresAt', 0)
    now = time.time() * 1000
    remaining = exp - now
    if remaining < $REFRESH_THRESHOLD_MS:
        print('yes')
        sys.exit(0)
except Exception:
    pass
print('no')
" 2>/dev/null || echo "no")

  if [ "$NEEDS_REFRESH" = "yes" ]; then
    echo "[refresh] OAuth token expiring soon, triggering refresh via claude CLI... ($(date))"
    # Run a minimal claude command to trigger the built-in OAuth refresh.
    # NOTE: Do NOT use --bare — it skips OAuth and fails with "Not logged in".
    # Use < /dev/null to avoid stdin warning. Retry up to 3 times.
    REFRESH_OK=false
    for attempt in 1 2 3; do
      if timeout 45 claude -p "ok" --max-turns 1 --output-format text < /dev/null > /dev/null 2>&1; then
        REFRESH_OK=true
        echo "[refresh] OAuth token refreshed successfully on attempt $attempt ($(date))"
        break
      else
        echo "[refresh] OAuth refresh attempt $attempt failed ($(date))"
        sleep 3
      fi
    done

    if [ "$REFRESH_OK" = "true" ]; then
      # Copy refreshed credentials to per-user cred dir
      if [ -n "$CRED_DIR" ] && [ -f "$CRED_DIR/claude-credentials.json" ]; then
        cp "$HOST_CREDS" "$CRED_DIR/claude-credentials.json"
        echo "[refresh] Synced refreshed token to $CRED_DIR ($(date))"
      fi
    else
      echo "[refresh] ERROR: OAuth token refresh failed after 3 attempts — token may expire soon ($(date))"
    fi
  fi
fi

# Refresh SSH config
openshell sandbox ssh-config "$SANDBOX" > "$SSH_CONF" 2>/dev/null || exit 0

ssh_cmd() {
  ssh -F "$SSH_CONF" -o StrictHostKeyChecking=no -o ConnectTimeout=5 "openshell-${SANDBOX}" "$@"
}

restart_gateway() {
  # Restart gateway so it picks up new config when required.
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
  ssh_cmd 'find /sandbox/.openclaw/cron /sandbox/.openclaw/agents -user root -delete 2>/dev/null' 2>/dev/null || true
  nohup ssh -F "$SSH_CONF" -o StrictHostKeyChecking=no -o ConnectTimeout=5 "openshell-${SANDBOX}" \
    'export HOME=/sandbox; openclaw gateway run >> /tmp/gateway.log 2>&1' </dev/null >/dev/null 2>&1 &
  disown
  sleep 5
  ssh_cmd 'export HOME=/sandbox; openclaw gateway call health > /dev/null 2>&1' 2>/dev/null
}

# Check sandbox is reachable
ssh_cmd 'true' 2>/dev/null || exit 0

# Re-inject Claude credentials (per-user dir first, then host default)
CLAUDE_CREDS=""
DESIRED_ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-}"
if [ -n "$CRED_DIR" ] && [ -f "$CRED_DIR/claude-credentials.json" ]; then
  CLAUDE_CREDS="$CRED_DIR/claude-credentials.json"
elif [ -f "$HOME/.claude/.credentials.json" ]; then
  CLAUDE_CREDS="$HOME/.claude/.credentials.json"
fi

if [ -n "$CLAUDE_CREDS" ]; then
  base64 "$CLAUDE_CREDS" | ssh_cmd 'base64 -d > /sandbox/.claude/.credentials.json && chmod 600 /sandbox/.claude/.credentials.json'

  # Use long-lived API key if available; otherwise extract fresh OAuth access token
  if [ "$IS_LONG_LIVED_KEY" = "true" ]; then
    : # Already set from environment (long-lived API key, not an OAuth token)
  else
    # Always read fresh access token from credentials file (may have been refreshed above)
    DESIRED_ANTHROPIC_KEY="$(python3 -c "import json; d=json.load(open('$CLAUDE_CREDS')); print(d.get('claudeAiOauth',{}).get('accessToken',''))" 2>/dev/null || true)"
  fi
fi

# Re-inject Anthropic API key if stored separately (per-user)
# If present, this overrides OAuth-derived keys.
ANTHROPIC_KEY_FILE=""
if [ -n "$CRED_DIR" ] && [ -f "$CRED_DIR/anthropic-key.txt" ]; then
  ANTHROPIC_KEY_FILE="$CRED_DIR/anthropic-key.txt"
  DESIRED_ANTHROPIC_KEY="$(cat "$ANTHROPIC_KEY_FILE")"
fi

GATEWAY_TOKEN="${GATEWAY_AUTH_TOKEN:?GATEWAY_AUTH_TOKEN must be set}"
CURRENT_ANTHROPIC_KEY="$(ssh_cmd "grep '^ANTHROPIC_API_KEY=' /sandbox/.env 2>/dev/null | tail -1 | cut -d= -f2-" 2>/dev/null || true)"
CURRENT_GATEWAY_TOKEN="$(ssh_cmd "python3 -c \"
import json, os
path = os.path.expanduser('~/.openclaw/openclaw.json')
try:
    cfg = json.load(open(path))
    print(cfg.get('gateway', {}).get('auth', {}).get('token', ''))
except Exception:
    print('')
\"" 2>/dev/null || true)"
GATEWAY_RESTART_NEEDED=false

if [ -n "$DESIRED_ANTHROPIC_KEY" ] && [ "$CURRENT_ANTHROPIC_KEY" != "$DESIRED_ANTHROPIC_KEY" ]; then
  ssh_cmd "python3 -c \"
import json, os
path = os.path.expanduser('~/.openclaw/openclaw.json')
cfg = json.load(open(path))
p = cfg.get('models',{}).get('providers',{}).get('anthropic',{})
if p:
    p['apiKey'] = '${DESIRED_ANTHROPIC_KEY}'
    json.dump(cfg, open(path, 'w'), indent=2)
    os.chmod(path, 0o600)
\"" 2>/dev/null

  # OpenClaw reads env vars with higher priority than models.json, so keep both in sync.
  ssh_cmd "grep -q ANTHROPIC_API_KEY /sandbox/.env 2>/dev/null && sed -i 's|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${DESIRED_ANTHROPIC_KEY}|' /sandbox/.env || echo 'ANTHROPIC_API_KEY=${DESIRED_ANTHROPIC_KEY}' >> /sandbox/.env; chmod 600 /sandbox/.env" 2>/dev/null
  GATEWAY_RESTART_NEEDED=true
fi

if [ "$CURRENT_GATEWAY_TOKEN" != "$GATEWAY_TOKEN" ]; then
  ssh_cmd "python3 -c \"
import json, os
path = os.path.expanduser('~/.openclaw/openclaw.json')
cfg = json.load(open(path))
gw = cfg.setdefault('gateway', {})
gw['auth'] = {'mode': 'token', 'token': '${GATEWAY_TOKEN}'}
gw['controlUi'] = {'allowInsecureAuth': True, 'dangerouslyDisableDeviceAuth': True, 'allowedOrigins': ['http://127.0.0.1:18789', 'http://localhost:18789']}
json.dump(cfg, open(path, 'w'), indent=2)
os.chmod(path, 0o600)
\"" 2>/dev/null
  GATEWAY_RESTART_NEEDED=true
fi

# Restore device pairing — server-side (gateway) + client-side (CLI identity)
PAIRED_FILE="$REPO_DIR/persist/gateway/paired.json"
IDENTITY_DIR="$REPO_DIR/persist/gateway/identity"
if [ -f "$PAIRED_FILE" ]; then
  ssh_cmd 'mkdir -p /sandbox/.openclaw/devices'
  base64 "$PAIRED_FILE" | ssh_cmd 'base64 -d > /sandbox/.openclaw/devices/paired.json && chmod 600 /sandbox/.openclaw/devices/paired.json'
fi
if [ -d "$IDENTITY_DIR" ]; then
  ssh_cmd 'mkdir -p /sandbox/.openclaw/identity'
  for f in "$IDENTITY_DIR"/*.json; do
    [ -f "$f" ] && base64 "$f" | ssh_cmd "base64 -d > /sandbox/.openclaw/identity/$(basename "$f") && chmod 600 /sandbox/.openclaw/identity/$(basename "$f")"
  done
fi

if ! ssh_cmd 'export HOME=/sandbox; openclaw gateway call health > /dev/null 2>&1' 2>/dev/null; then
  GATEWAY_RESTART_NEEDED=true
fi

if [ "$GATEWAY_RESTART_NEEDED" = "true" ]; then
  if restart_gateway; then
    echo "[refresh] Gateway restarted for $SANDBOX ($(date))"
  else
    echo "[refresh] WARNING: Gateway restart failed for $SANDBOX ($(date))"
  fi
else
  echo "[refresh] Gateway restart skipped for $SANDBOX — no relevant config change ($(date))"
fi

if [ -n "$CLAUDE_CREDS" ]; then
  echo "[refresh] Claude credentials synced for $SANDBOX from $CLAUDE_CREDS ($(date))"
fi
if [ -n "$ANTHROPIC_KEY_FILE" ]; then
  echo "[refresh] Anthropic API key enforced from per-user credentials for $SANDBOX ($(date))"
fi

# Re-inject GOG_KEYRING_PASSWORD (strictly per-user)
GOG_KEYRING_PW=""
if [ -n "$USER_ENV_FILE" ] && [ -f "$USER_ENV_FILE" ]; then
  GOG_KEYRING_PW="$(bash -lc 'set -a; . "$1"; set +a; printf "%s" "${GOG_KEYRING_PASSWORD:-}"' _ "$USER_ENV_FILE" 2>/dev/null || true)"
fi
if [ -n "$GOG_KEYRING_PW" ]; then
  ssh_cmd "grep -q GOG_KEYRING_PASSWORD /sandbox/.env 2>/dev/null && sed -i 's|^GOG_KEYRING_PASSWORD=.*|GOG_KEYRING_PASSWORD=${GOG_KEYRING_PW}|' /sandbox/.env || echo 'GOG_KEYRING_PASSWORD=${GOG_KEYRING_PW}' >> /sandbox/.env; chmod 600 /sandbox/.env" 2>/dev/null
fi

# ── Proactive Google OAuth token refresh ─────────────────────────────
# Exercise the GOG refresh token by making a lightweight Gmail labels call.
# This keeps the refresh token alive (Google revokes unused tokens after
# 6 months, or 7 days if the OAuth app is in "Testing" mode).
# If the token has already been revoked (invalid_grant), log a warning.
if [ -n "$GOG_KEYRING_PW" ] && ssh_cmd 'test -d /sandbox/.config/gogcli' 2>/dev/null; then
  GOG_REFRESH_RESULT=$(ssh_cmd 'export HOME=/sandbox; export PATH=/sandbox/.local/bin:$PATH; export GOG_KEYRING_PASSWORD='"${GOG_KEYRING_PW}"'; gog gmail labels list -a "$(gog auth list -p 2>/dev/null | head -1)" --json 2>&1 | head -5' 2>/dev/null || true)
  if echo "$GOG_REFRESH_RESULT" | grep -q "invalid_grant"; then
    echo "[refresh] WARNING: Google OAuth token revoked (invalid_grant) for $SANDBOX — manual re-auth needed ($(date))"
  elif echo "$GOG_REFRESH_RESULT" | grep -q "labels"; then
    echo "[refresh] Google OAuth token exercised successfully for $SANDBOX ($(date))"
  fi
fi

# Re-inject Slack bot token (for heartbeat DMs)
if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
  ssh_cmd "grep -q SLACK_BOT_TOKEN /sandbox/.env 2>/dev/null && sed -i 's|^SLACK_BOT_TOKEN=.*|SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}|' /sandbox/.env || echo 'SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}' >> /sandbox/.env; chmod 600 /sandbox/.env" 2>/dev/null
fi

# Re-inject Slack webhook URL (strictly per-user)
if [ -n "$CRED_DIR" ] && [ -f "$CRED_DIR/slack-webhook-url.txt" ]; then
  USER_SLACK_WEBHOOK="$(cat "$CRED_DIR/slack-webhook-url.txt")"
  ssh_cmd "grep -q SLACK_WEBHOOK_URL /sandbox/.env 2>/dev/null && sed -i 's|^SLACK_WEBHOOK_URL=.*|SLACK_WEBHOOK_URL=${USER_SLACK_WEBHOOK}|' /sandbox/.env || echo 'SLACK_WEBHOOK_URL=${USER_SLACK_WEBHOOK}' >> /sandbox/.env; chmod 600 /sandbox/.env" 2>/dev/null
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
