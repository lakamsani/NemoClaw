#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Full bring-up script for NemoClaw after sandbox restart or host reboot.
# Idempotent — safe to run whether sandbox is already up or not.
#
# Sequence: sandbox wait → policy → credentials → workspace → services
#
# Usage:
#   ./scripts/nemoclaw-resilience.sh
#   ./scripts/nemoclaw-resilience.sh --sandbox veyonce-claw
#   ./scripts/nemoclaw-resilience.sh --all                    # All registered users
#   ./scripts/nemoclaw-resilience.sh --sandbox X --cred-dir persist/users/U.../credentials --github-user alice

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source .env
if [ -f "$REPO_DIR/.env" ]; then
  set -a; . "$REPO_DIR/.env"; set +a
fi

SANDBOX="${NEMOCLAW_SANDBOX:-veyonce-claw}"
CRED_DIR=""
GITHUB_USER=""
SLACK_USER_ID=""
ALL_USERS=false

# Parse args
while [ $# -gt 0 ]; do
  case "$1" in
    --sandbox) SANDBOX="${2:?--sandbox requires a name}"; shift 2 ;;
    --cred-dir) CRED_DIR="${2:?--cred-dir requires a path}"; shift 2 ;;
    --github-user) GITHUB_USER="${2:?--github-user requires a name}"; shift 2 ;;
    --slack-user-id) SLACK_USER_ID="${2:?--slack-user-id requires a value}"; shift 2 ;;
    --all) ALL_USERS=true; shift ;;
    *) shift ;;
  esac
done

# ── --all mode: iterate over all registered users ─────────────────
if [ "$ALL_USERS" = "true" ]; then
  USERS_FILE="$HOME/.nemoclaw/users.json"
  if [ ! -f "$USERS_FILE" ]; then
    echo "[resilience] No users.json found at $USERS_FILE"
    exit 1
  fi

  USER_IDS=$(python3 -c "import json; d=json.load(open('$USERS_FILE')); [print(uid) for uid, u in d.get('users',{}).items() if u.get('enabled', True)]")

  for uid in $USER_IDS; do
    USER_SANDBOX=$(python3 -c "import json; print(json.load(open('$USERS_FILE'))['users']['$uid']['sandboxName'])")
    USER_CRED_DIR=$(python3 -c "import json; print(json.load(open('$USERS_FILE'))['users']['$uid']['credentialsDir'])")
    USER_GITHUB=$(python3 -c "import json; print(json.load(open('$USERS_FILE'))['users']['$uid'].get('githubUser',''))")
    USER_NAME=$(python3 -c "import json; print(json.load(open('$USERS_FILE'))['users']['$uid'].get('slackDisplayName','$uid'))")

    echo ""
    echo "================================================================"
    echo "[resilience] Bringing up user: $USER_NAME ($uid) → $USER_SANDBOX"
    echo "================================================================"

    GITHUB_FLAG=""
    [ -n "$USER_GITHUB" ] && GITHUB_FLAG="--github-user $USER_GITHUB"

    "$0" --sandbox "$USER_SANDBOX" --cred-dir "$USER_CRED_DIR" --slack-user-id "$uid" $GITHUB_FLAG || {
      echo "[resilience] FAILED for user $USER_NAME ($USER_SANDBOX) — continuing..."
    }
  done

  echo ""
  echo "[resilience] All users processed."
  exit 0
fi

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[resilience]${NC} $1"; }
warn()  { echo -e "${YELLOW}[resilience]${NC} $1"; }
fail()  { echo -e "${RED}[resilience]${NC} $1"; exit 1; }

# ── Step 1: Wait for sandbox to be Ready ─────────────────────────
info "Waiting for sandbox '$SANDBOX' to be Ready..."
READY=false
for i in $(seq 1 36); do
  if openshell sandbox list 2>&1 | grep -q "${SANDBOX}.*Ready"; then
    READY=true
    break
  fi
  sleep 5
done

if [ "$READY" != "true" ]; then
  fail "Sandbox '$SANDBOX' not in Ready state after 3 minutes. Is it created?"
fi
info "Sandbox '$SANDBOX' is Ready"

# ── Step 2: Generate SSH config ──────────────────────────────────
SSH_CONF="/tmp/ssh-config-${SANDBOX}"
openshell sandbox ssh-config "$SANDBOX" > "$SSH_CONF" 2>/dev/null
info "SSH config generated"

ssh_cmd() {
  ssh -F "$SSH_CONF" -o StrictHostKeyChecking=no "openshell-${SANDBOX}" "$@"
}

# ── Step 3: Apply merged network policy ──────────────────────────
POLICY_DIR="$REPO_DIR/nemoclaw-blueprint/policies"
PRESETS=()
for preset in google.yaml xcurl.yaml slack.yaml npm.yaml pypi.yaml anthropic.yaml freshworks.yaml; do
  [ -f "$POLICY_DIR/presets/$preset" ] && PRESETS+=("$POLICY_DIR/presets/$preset")
done

python3 "$SCRIPT_DIR/merge-policy.py" \
  "$POLICY_DIR/openclaw-sandbox.yaml" \
  "${PRESETS[@]}" \
  > /tmp/nemoclaw-merged-policy.yaml

openshell policy set --policy /tmp/nemoclaw-merged-policy.yaml "$SANDBOX" 2>&1 | tail -1
info "Network policy applied"

# ── Step 4: Inject credentials ───────────────────────────────────
if [ -n "$CRED_DIR" ]; then
  # Multi-user mode: use per-user credential injection script
  GITHUB_FLAG=""
  [ -n "$GITHUB_USER" ] && GITHUB_FLAG="--github-user $GITHUB_USER"
  SLACK_FLAG=""
  [ -n "$SLACK_USER_ID" ] && SLACK_FLAG="--slack-user-id $SLACK_USER_ID"
  "$SCRIPT_DIR/inject-user-credentials.sh" "$SANDBOX" "$CRED_DIR" $GITHUB_FLAG $SLACK_FLAG
  info "Per-user credentials injected via inject-user-credentials.sh"

  # Extract ANTHROPIC_API_KEY for openclaw config from per-user credentials
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    if [ -n "$CRED_DIR" ] && [[ "$CRED_DIR" == /* ]]; then
      CRED_ABS="$CRED_DIR"
    else
      CRED_ABS="$REPO_DIR/$CRED_DIR"
    fi
    if [ -f "$CRED_ABS/claude-oauth-token.txt" ]; then
      ANTHROPIC_API_KEY="$(cat "$CRED_ABS/claude-oauth-token.txt")"
    elif [ -f "$CRED_ABS/claude-credentials.json" ]; then
      ANTHROPIC_API_KEY="$(python3 -c "import json; d=json.load(open('$CRED_ABS/claude-credentials.json')); print(d.get('claudeAiOauth',{}).get('accessToken',''))" 2>/dev/null || true)"
    fi
  fi
else
  # Legacy single-user mode is no longer configured for shared Claude OAuth.
  warn "No per-user credential directory provided. Shared Claude fallback is disabled."

  # Claude MCP auth cache
  if [ -f "$HOME/.claude/mcp-needs-auth-cache.json" ]; then
    base64 "$HOME/.claude/mcp-needs-auth-cache.json" | ssh_cmd 'base64 -d > /sandbox/.claude/mcp-needs-auth-cache.json && chmod 600 /sandbox/.claude/mcp-needs-auth-cache.json'
    info "Claude MCP auth cache injected"
  fi

  # Claude settings
  if [ -f "$HOME/.claude/settings.json" ]; then
    base64 "$HOME/.claude/settings.json" | ssh_cmd 'base64 -d > /sandbox/.claude/settings.json'
    info "Claude settings injected"
  fi

  # GitHub token
  GH_TOKEN="${GH_TOKEN:-}"
  if [ -z "$GH_TOKEN" ] && command -v gh > /dev/null 2>&1; then
    GH_TOKEN="$(gh auth token 2>/dev/null || true)"
  fi
  if [ -n "$GH_TOKEN" ]; then
    ssh_cmd "mkdir -p /sandbox/.config/gh && cat > /sandbox/.config/gh/hosts.yml" <<GHEOF
github.com:
  oauth_token: ${GH_TOKEN}
  user: lakamsani
  git_protocol: https
GHEOF
    ssh_cmd 'chmod 600 /sandbox/.config/gh/hosts.yml'
    info "GitHub token injected"
  else
    warn "No GitHub token available"
  fi

  # Google service account
  GOOGLE_SA_PATH="${GOOGLE_APPLICATION_CREDENTIALS:-$HOME/lakmsani-gmail-service-account.json}"
  if [ -f "$GOOGLE_SA_PATH" ]; then
    ssh_cmd 'mkdir -p /sandbox/.config/gcloud'
    base64 "$GOOGLE_SA_PATH" | ssh_cmd 'base64 -d > /sandbox/.config/gcloud/service-account.json && chmod 600 /sandbox/.config/gcloud/service-account.json'
    info "Google service account injected"
  fi

  # gog OAuth credentials
  if [ -d "$HOME/.config/gogcli" ]; then
    cd "$HOME/.config/gogcli" && tar czf - . | ssh_cmd 'mkdir -p /sandbox/.config/gogcli && tar xzf - -C /sandbox/.config/gogcli && chmod -R 700 /sandbox/.config/gogcli'
    cd "$REPO_DIR"
    info "gog OAuth credentials injected"
  fi

  # xurl config (X/Twitter)
  XURL_BIN="$REPO_DIR/persist/xurl-linux-arm64"
  if [ -f "$XURL_BIN" ]; then
    base64 "$XURL_BIN" | ssh_cmd 'mkdir -p /sandbox/.local/bin && base64 -d > /sandbox/.local/bin/xurl && chmod +x /sandbox/.local/bin/xurl'
    info "xurl binary injected"
  fi

  TWITTER_CREDS="${TWITTER_CREDS_PATH:-$HOME/twitter-claw.txt}"
  if [ -f "$TWITTER_CREDS" ]; then
    set -a; . "$TWITTER_CREDS"; set +a
    ssh_cmd "export PATH='/sandbox/.local/bin:\$PATH' && \
      python3 -c \"import os; f=os.path.expanduser('~/.xurl'); os.path.exists(f) and os.remove(f)\" 2>/dev/null; \
      xurl auth apps add nemoclaw --client-id '${X_API_KEY}' --client-secret '${X_API_KEY_SECRET}' 2>/dev/null; \
      xurl auth oauth1 --consumer-key '${X_API_KEY}' --consumer-secret '${X_API_KEY_SECRET}' --access-token '${X_ACCESS_TOKEN}' --token-secret '${X_ACCESS_TOKEN_SECRET}' 2>/dev/null; \
      xurl auth app --bearer-token '${X_BEARER_TOKEN}' 2>/dev/null; \
      xurl auth default default 2>/dev/null" 2>&1 | grep -v '^\[' || true
    info "xurl (X/Twitter) credentials configured"
  else
    warn "No twitter credentials at $TWITTER_CREDS"
  fi

  # Git config
  ssh_cmd 'git config --global user.name "lakamsani" && git config --global user.email "lakamsani@users.noreply.github.com"' 2>/dev/null
  info "Git config set"

  # Slack webhook URL (fallback for heartbeat)
  if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
    ssh_cmd "grep -q SLACK_WEBHOOK_URL /sandbox/.env 2>/dev/null && sed -i 's|^SLACK_WEBHOOK_URL=.*|SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}|' /sandbox/.env || echo 'SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}' >> /sandbox/.env"
    ssh_cmd 'chmod 600 /sandbox/.env'
    info "Slack webhook URL injected"
  fi

  # Slack bot token + user ID (for DM-based heartbeat notifications)
  if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
    ssh_cmd "grep -q SLACK_BOT_TOKEN /sandbox/.env 2>/dev/null && sed -i 's|^SLACK_BOT_TOKEN=.*|SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}|' /sandbox/.env || echo 'SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}' >> /sandbox/.env; chmod 600 /sandbox/.env"
    info "Slack bot token injected"
  fi
  if [ -n "$SLACK_USER_ID" ]; then
    ssh_cmd "grep -q SLACK_USER_ID /sandbox/.env 2>/dev/null && sed -i 's|^SLACK_USER_ID=.*|SLACK_USER_ID=${SLACK_USER_ID}|' /sandbox/.env || echo 'SLACK_USER_ID=${SLACK_USER_ID}' >> /sandbox/.env; chmod 600 /sandbox/.env"
    info "Slack user ID injected ($SLACK_USER_ID)"
  fi

  # slack-notify helper script
  NOTIFY_SCRIPT="$SCRIPT_DIR/slack-notify.sh"
  if [ -f "$NOTIFY_SCRIPT" ]; then
    base64 "$NOTIFY_SCRIPT" | ssh_cmd 'mkdir -p /sandbox/.local/bin && base64 -d > /sandbox/.local/bin/slack-notify && chmod +x /sandbox/.local/bin/slack-notify'
    info "slack-notify helper installed"
  fi

  # GOG_KEYRING_PASSWORD
  GOG_KEYRING_PW="${GOG_KEYRING_PASSWORD:-nemoclaw}"
  ssh_cmd "grep -q GOG_KEYRING_PASSWORD /sandbox/.env 2>/dev/null && sed -i 's|^GOG_KEYRING_PASSWORD=.*|GOG_KEYRING_PASSWORD=${GOG_KEYRING_PW}|' /sandbox/.env || echo 'GOG_KEYRING_PASSWORD=${GOG_KEYRING_PW}' >> /sandbox/.env; chmod 600 /sandbox/.env"
  info "GOG_KEYRING_PASSWORD injected"

  # Shell profile (.bashrc)
  ssh_cmd 'cat > /sandbox/.bashrc << "BASHRC"
# NemoClaw sandbox shell profile
export PATH="/sandbox/.local/bin:$PATH"
if [ -f /sandbox/.env ]; then set -a; . /sandbox/.env; set +a; fi
BASHRC
chmod 644 /sandbox/.bashrc'
  info "Shell profile (.bashrc) created"
fi

# ── Step 5a: Patch OpenClaw config with Anthropic (if API key available) ──
GATEWAY_TOKEN="${GATEWAY_AUTH_TOKEN:?GATEWAY_AUTH_TOKEN must be set}"
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  ssh_cmd "python3 -c \"
import json, os
path = os.path.expanduser('~/.openclaw/openclaw.json')
cfg = json.load(open(path))
providers = cfg.setdefault('models', {}).setdefault('providers', {})
if 'anthropic' not in providers:
    providers['anthropic'] = {'baseUrl': 'https://api.anthropic.com/v1', 'api': 'anthropic-messages', 'models': [{'id': 'claude-sonnet-4-6', 'name': 'Claude Sonnet 4.6', 'reasoning': False, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 200000, 'maxTokens': 64000}]}
providers['anthropic']['apiKey'] = '${ANTHROPIC_API_KEY}'
cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = 'anthropic/claude-sonnet-4-6'
json.dump(cfg, open(path, 'w'), indent=2)
os.chmod(path, 0o600)

# Write auth profiles
profiles = {}
profiles['anthropic:manual'] = {'type': 'api_key', 'provider': 'anthropic', 'keyRef': {'source': 'env', 'id': 'ANTHROPIC_API_KEY'}, 'profileId': 'anthropic:manual'}
apath = os.path.expanduser('~/.openclaw/agents/main/agent/auth-profiles.json')
os.makedirs(os.path.dirname(apath), exist_ok=True)
json.dump(profiles, open(apath, 'w'))
os.chmod(apath, 0o600)
\"" 2>/dev/null
  info "OpenClaw config patched (anthropic/claude-sonnet-4-6)"
else
  warn "No ANTHROPIC_API_KEY — OpenClaw will use default Nemotron model"
fi

# ── Step 5b: Gateway auth, device pairing, and start (always runs) ──
# Patch gateway auth token + controlUi settings
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
info "Gateway auth token set"

# Restore device pairing — server-side (gateway) + client-side (CLI identity)
PAIRED_FILE="$REPO_DIR/persist/gateway/paired.json"
IDENTITY_DIR="$REPO_DIR/persist/gateway/identity"
if [ -f "$PAIRED_FILE" ]; then
  ssh_cmd 'mkdir -p /sandbox/.openclaw/devices'
  base64 "$PAIRED_FILE" | ssh_cmd 'base64 -d > /sandbox/.openclaw/devices/paired.json && chmod 600 /sandbox/.openclaw/devices/paired.json'
  info "Device pairing restored (server-side)"
fi
if [ -d "$IDENTITY_DIR" ]; then
  ssh_cmd 'mkdir -p /sandbox/.openclaw/identity'
  for f in "$IDENTITY_DIR"/*.json; do
    [ -f "$f" ] && base64 "$f" | ssh_cmd "base64 -d > /sandbox/.openclaw/identity/$(basename "$f") && chmod 600 /sandbox/.openclaw/identity/$(basename "$f")"
  done
  info "Device identity restored (client-side)"
fi

# Kill any existing gateway, then start fresh
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
# Preserve cron jobs and agent state across restarts. Repair ownership instead
# of deleting root-owned files so installed heartbeat jobs survive.
ssh_cmd 'chown -R sandbox:sandbox /sandbox/.openclaw/cron /sandbox/.openclaw/agents 2>/dev/null' 2>/dev/null || true
# Start gateway in a separate SSH session that stays alive
# Use nohup + disown so the SSH session survives parent shell exit (e.g. cron)
nohup ssh -F "$SSH_CONF" -o StrictHostKeyChecking=no -o ConnectTimeout=5 "openshell-${SANDBOX}" \
  'export HOME=/sandbox; openclaw gateway run >> /tmp/gateway.log 2>&1' </dev/null >/dev/null 2>&1 &
disown

GATEWAY_HEALTHY=false
for i in $(seq 1 10); do
  if ssh_cmd 'export HOME=/sandbox; openclaw gateway call health > /dev/null 2>&1' 2>/dev/null; then
    GATEWAY_HEALTHY=true
    break
  fi
  sleep 2
done

if [ "$GATEWAY_HEALTHY" != "true" ]; then
  fail "Gateway failed health check after restart for sandbox '$SANDBOX'"
fi
info "Gateway started and healthy"

# ── Step 6: Restore workspace personality files ──────────────────
# Try per-user workspace first, then fall back to default
PERSIST_DIR=""
if [ -n "$CRED_DIR" ]; then
  # Derive workspace dir from cred dir (sibling directory)
  if [[ "$CRED_DIR" == /* ]]; then
    PERSIST_DIR="$(dirname "$CRED_DIR")/workspace"
  else
    PERSIST_DIR="$REPO_DIR/$(dirname "$CRED_DIR")/workspace"
  fi
fi
if [ -z "$PERSIST_DIR" ] || [ ! -d "$PERSIST_DIR" ]; then
  PERSIST_DIR="$REPO_DIR/persist/workspace"
fi

if [ -d "$PERSIST_DIR" ] && [ -f "$PERSIST_DIR/SOUL.md" ]; then
  cd "$PERSIST_DIR" && tar czf - . | ssh_cmd 'tar xzf - -C /sandbox/.openclaw/workspace/'
  cd "$REPO_DIR"
  info "Workspace personality files restored from $PERSIST_DIR"
else
  warn "No workspace backup at $PERSIST_DIR"
fi

# ── Step 6b: Upgrade Claude Code to latest ─────────────────────
# Install to /sandbox/.local so it takes priority over the system version
# (/sandbox/.local/bin is first on PATH via .bashrc).
CURRENT_CC="$(ssh_cmd 'export PATH="/sandbox/.local/bin:$PATH" && claude --version 2>/dev/null' 2>/dev/null | grep -oP '[\d.]+' | head -1 || true)"
LATEST_CC="$(npm view @anthropic-ai/claude-code version 2>/dev/null || true)"
if [ -n "$LATEST_CC" ] && [ "$CURRENT_CC" != "$LATEST_CC" ]; then
  ssh_cmd "npm install -g --prefix /sandbox/.local @anthropic-ai/claude-code@${LATEST_CC}" 2>&1 | tail -2
  info "Claude Code upgraded: ${CURRENT_CC:-unknown} → ${LATEST_CC}"
else
  info "Claude Code already at latest (${CURRENT_CC:-unknown})"
fi

# ── Step 6c: Install freshrelease-mcp from bundled wheels ─────
WHEELS_TAR="$REPO_DIR/persist/packages/freshrelease-mcp-wheels.tar.gz"
if [ -f "$WHEELS_TAR" ]; then
  CURRENT_FR="$(ssh_cmd 'freshrelease-mcp --version 2>/dev/null || true' 2>/dev/null)"
  if [ -z "$CURRENT_FR" ]; then
    cat "$WHEELS_TAR" | ssh_cmd 'cat > /tmp/wheels.tar.gz && mkdir -p /tmp/wheels && tar xzf /tmp/wheels.tar.gz -C /tmp/wheels && pip3 install --break-system-packages --no-deps --no-index --find-links /tmp/wheels freshrelease-mcp 2>&1 | tail -1 && rm -rf /tmp/wheels /tmp/wheels.tar.gz'
    info "freshrelease-mcp installed from bundled wheels"
  else
    info "freshrelease-mcp already installed ($CURRENT_FR)"
  fi
fi

# ── Step 7: Restore cron jobs ──────────────────────────────────
"$SCRIPT_DIR/setup-cron.sh" 2>&1 | grep '\[cron\]' || true
info "Cron jobs restored"

# ── Step 8: Start Slack bridge ───────────────────────────────────
"$SCRIPT_DIR/start-services.sh" --sandbox "$SANDBOX" 2>&1 | grep -E '\[services\]|┌|│|└'
info "Services started"

# ── Step 9: Ensure heartbeat cron job exists ─────────────────────
HEARTBEAT_FLAGS=""
[ -n "$SLACK_USER_ID" ] && HEARTBEAT_FLAGS="--slack-user-id $SLACK_USER_ID"
SSH_CONF="$SSH_CONF" "$SCRIPT_DIR/setup-heartbeat-cron.sh" "$SANDBOX" $HEARTBEAT_FLAGS 2>&1 | grep '\[heartbeat-cron\]' || true
info "Heartbeat cron job checked"

echo ""
info "NemoClaw fully operational — sandbox: $SANDBOX"
