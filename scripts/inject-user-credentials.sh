#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Copy per-user credentials from host into a NemoClaw sandbox.
# Parameterized version of inject-credentials.sh for multi-user support.
#
# Usage:
#   ./scripts/inject-user-credentials.sh <sandbox-name> <cred-dir> [--github-user <user>] [--slack-user-id <id>]
#
# Example:
#   ./scripts/inject-user-credentials.sh veyonce-claw persist/users/U09R681EPQ9/credentials --github-user lakamsani --slack-user-id U09R681EPQ9

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$REPO_DIR/.env" ]; then
  set -a; . "$REPO_DIR/.env"; set +a
fi

SANDBOX="${1:?Usage: inject-user-credentials.sh <sandbox-name> <cred-dir> [--github-user <user>]}"
CRED_DIR="${2:?Usage: inject-user-credentials.sh <sandbox-name> <cred-dir>}"
shift 2

# Resolve relative cred dir to absolute
if [[ "$CRED_DIR" != /* ]]; then
  CRED_DIR="$REPO_DIR/$CRED_DIR"
fi

GITHUB_USER=""
GITHUB_EMAIL=""
SLACK_USER_ID=""

while [ $# -gt 0 ]; do
  case "$1" in
    --github-user) GITHUB_USER="${2:?--github-user requires a value}"; shift 2 ;;
    --github-email) GITHUB_EMAIL="${2:?--github-email requires a value}"; shift 2 ;;
    --slack-user-id) SLACK_USER_ID="${2:?--slack-user-id requires a value}"; shift 2 ;;
    *) shift ;;
  esac
done

# Default email from github user
if [ -n "$GITHUB_USER" ] && [ -z "$GITHUB_EMAIL" ]; then
  GITHUB_EMAIL="${GITHUB_USER}@users.noreply.github.com"
fi

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[inject]${NC} $1"; }
warn()  { echo -e "${YELLOW}[inject]${NC} $1"; }
fail()  { echo -e "${RED}[inject]${NC} $1"; exit 1; }

SSH_CONF="/tmp/ssh-config-${SANDBOX}"
openshell sandbox ssh-config "$SANDBOX" > "$SSH_CONF" 2>/dev/null || fail "Cannot get SSH config for $SANDBOX"

ssh_cmd() {
  ssh -F "$SSH_CONF" -o StrictHostKeyChecking=no "openshell-${SANDBOX}" "$@"
}

patch_claude_runtime() {
  local anthropic_key="${1:-}"
  local token_json="''"
  if [ -n "$anthropic_key" ]; then
    token_json="$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$anthropic_key")"
  fi
  local script
  script=$(cat <<PYSCRIPT
import json, os
path = os.path.expanduser('~/.openclaw/openclaw.json')
if not os.path.exists(path):
    raise SystemExit(0)
key = ${token_json}
cfg = json.load(open(path))
providers = cfg.setdefault('models', {}).setdefault('providers', {})
anthropic = providers.get('anthropic')
if isinstance(anthropic, dict) and key:
    anthropic['apiKey'] = key
cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = 'anthropic/claude-sonnet-4-6'
json.dump(cfg, open(path, 'w'), indent=2)
os.chmod(path, 0o600)
PYSCRIPT
)
  local b64_script
  b64_script="$(printf '%s' "$script" | base64 -w0)"
  if ! printf '%s' "$b64_script" | ssh_cmd 'base64 -d | python3' 2>/dev/null; then
    warn "Skipping runtime openclaw.json patch; sandbox cannot rewrite ~/.openclaw/openclaw.json"
  fi
}

# Ensure target directories exist
ssh_cmd 'mkdir -p /sandbox/.claude /sandbox/.config/gh'

# ── Claude long-lived Teams token (preferred when present) ──────
if [ -f "$CRED_DIR/claude-oauth-token.txt" ]; then
  CLAUDE_OAUTH_TOKEN="$(cat "$CRED_DIR/claude-oauth-token.txt")"
  ssh_cmd "grep -q CLAUDE_CODE_OAUTH_TOKEN /sandbox/.env 2>/dev/null && sed -i 's|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_OAUTH_TOKEN}|' /sandbox/.env || echo 'CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_OAUTH_TOKEN}' >> /sandbox/.env; chmod 600 /sandbox/.env"
  ssh_cmd "grep -q ANTHROPIC_API_KEY /sandbox/.env 2>/dev/null && sed -i 's|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${CLAUDE_OAUTH_TOKEN}|' /sandbox/.env || echo 'ANTHROPIC_API_KEY=${CLAUDE_OAUTH_TOKEN}' >> /sandbox/.env; chmod 600 /sandbox/.env"
  # Also write .credentials.json so claude --print works (it reads this, not .env)
  ssh_cmd "python3 -c \"
import json, os
creds = {
    'claudeAiOauth': {
        'accessToken': '${CLAUDE_OAUTH_TOKEN}',
        'refreshToken': '',
        'expiresAt': 9999999999999,
        'scopes': ['user:inference', 'user:mcp_servers', 'user:profile', 'user:sessions:claude_code'],
        'subscriptionType': 'team',
        'rateLimitTier': 'default_claude_max_5x'
    }
}
os.makedirs('/sandbox/.claude', exist_ok=True)
json.dump(creds, open('/sandbox/.claude/.credentials.json', 'w'), indent=2)
os.chmod('/sandbox/.claude/.credentials.json', 0o600)
\"" 2>/dev/null
  patch_claude_runtime "$CLAUDE_OAUTH_TOKEN"
  info "Claude long-lived token injected (per-user, .env + .credentials.json)"
fi

# ── Claude Code credentials (fallback if no long-lived token) ────
if [ ! -f "$CRED_DIR/claude-oauth-token.txt" ] && [ -f "$CRED_DIR/claude-credentials.json" ]; then
  base64 "$CRED_DIR/claude-credentials.json" | ssh_cmd 'base64 -d > /sandbox/.claude/.credentials.json && chmod 600 /sandbox/.claude/.credentials.json'
  CLAUDE_ACCESS_TOKEN="$(python3 -c "import json; d=json.load(open('$CRED_DIR/claude-credentials.json')); print(d.get('claudeAiOauth',{}).get('accessToken',''))" 2>/dev/null || true)"
  if [ -n "$CLAUDE_ACCESS_TOKEN" ]; then
    ssh_cmd "grep -q ANTHROPIC_API_KEY /sandbox/.env 2>/dev/null && sed -i 's|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${CLAUDE_ACCESS_TOKEN}|' /sandbox/.env || echo 'ANTHROPIC_API_KEY=${CLAUDE_ACCESS_TOKEN}' >> /sandbox/.env; chmod 600 /sandbox/.env"
    patch_claude_runtime "$CLAUDE_ACCESS_TOKEN"
  fi
  info "Claude credentials.json injected (per-user)"
elif [ ! -f "$CRED_DIR/claude-oauth-token.txt" ]; then
  warn "No per-user Claude credentials found"
fi

# Claude settings
if [ -f "$CRED_DIR/claude-settings.json" ]; then
  base64 "$CRED_DIR/claude-settings.json" | ssh_cmd 'base64 -d > /sandbox/.claude/settings.json'
  info "Claude settings injected (per-user)"
fi

# ── Freshrelease API key (injected into sandbox .env and mcporter MCP config) ──
if [ -f "$CRED_DIR/freshrelease-api-key.txt" ]; then
  FR_KEY="$(cat "$CRED_DIR/freshrelease-api-key.txt" | tr -d '[:space:]')"
  ssh_cmd "grep -q FRESHRELEASE_API_KEY /sandbox/.env 2>/dev/null && sed -i 's|^FRESHRELEASE_API_KEY=.*|FRESHRELEASE_API_KEY=${FR_KEY}|' /sandbox/.env || echo 'FRESHRELEASE_API_KEY=${FR_KEY}' >> /sandbox/.env; chmod 600 /sandbox/.env"
  ssh_cmd "mkdir -p /sandbox/.mcporter /sandbox/.local/bin"
  ssh_cmd "python3 -c \"
import json, os
path = '/sandbox/.mcporter/mcporter.json'
cfg = {}
if os.path.exists(path):
    cfg = json.load(open(path))
mcp = cfg.setdefault('mcpServers', {})
mcp['freshrelease'] = {
    'transport': 'stdio',
    'command': '/usr/local/bin/freshrelease-mcp',
    'args': [],
    'env': {
        'FRESHRELEASE_DOMAIN': 'freshworks.freshrelease.com',
        'FRESHRELEASE_API_KEY': '${FR_KEY}',
        'NO_PROXY': 'localhost,127.0.0.1,::1,10.200.0.1,freshworks.freshrelease.com',
        'no_proxy': 'localhost,127.0.0.1,::1,10.200.0.1,freshworks.freshrelease.com'
    },
    'description': 'Freshrelease MCP server'
}
json.dump(cfg, open(path, 'w'), indent=2)
os.chmod(path, 0o644)
\"" 2>/dev/null
  info "Freshrelease API key injected into .env and mcporter MCP config"
fi

# ── Claude MCP auth cache ────────────────────────────────────────
if [ -f "$CRED_DIR/mcp-needs-auth-cache.json" ]; then
  base64 "$CRED_DIR/mcp-needs-auth-cache.json" | ssh_cmd 'base64 -d > /sandbox/.claude/mcp-needs-auth-cache.json && chmod 600 /sandbox/.claude/mcp-needs-auth-cache.json'
  info "Claude MCP auth cache injected (per-user)"
fi

# ── Claude credentials.json (OAuth session for claude --print) ───
if [ -f "$CRED_DIR/claude-credentials.json" ]; then
  base64 "$CRED_DIR/claude-credentials.json" | ssh_cmd 'base64 -d > /sandbox/.claude/.credentials.json && chmod 600 /sandbox/.claude/.credentials.json'
  info "Claude credentials.json injected (per-user)"
fi

# ── GitHub token (per-user only — no host fallback) ──────────────
if [ -f "$CRED_DIR/gh-hosts.yml" ]; then
  base64 "$CRED_DIR/gh-hosts.yml" | ssh_cmd 'mkdir -p /sandbox/.config/gh && base64 -d > /sandbox/.config/gh/hosts.yml && chmod 600 /sandbox/.config/gh/hosts.yml'
  info "GitHub token injected (from user credentials)"
fi

# ── Google service account ───────────────────────────────────────
GOOGLE_SA_PATH="$CRED_DIR/service-account.json"
if [ ! -f "$GOOGLE_SA_PATH" ]; then
  GOOGLE_SA_PATH="${GOOGLE_APPLICATION_CREDENTIALS:-$HOME/lakmsani-gmail-service-account.json}"
fi
if [ -f "$GOOGLE_SA_PATH" ]; then
  ssh_cmd 'mkdir -p /sandbox/.config/gcloud'
  base64 "$GOOGLE_SA_PATH" | ssh_cmd 'base64 -d > /sandbox/.config/gcloud/service-account.json && chmod 600 /sandbox/.config/gcloud/service-account.json'
  info "Google service account injected"
fi

# ── gog CLI (Google OAuth) credentials (per-user only — no host fallback) ──
GOG_DIR="$CRED_DIR/gogcli"
if [ -d "$GOG_DIR" ]; then
  cd "$GOG_DIR" && tar czf - . | ssh_cmd 'mkdir -p /sandbox/.config/gogcli && tar xzf - -C /sandbox/.config/gogcli && chmod -R 700 /sandbox/.config/gogcli'
  cd "$REPO_DIR"
  info "gog OAuth credentials injected"
fi

# ── User-specific .env values ────────────────────────────────────
# GOG keyring password (per-user only)
if [ -f "$CRED_DIR/../.env" ]; then
  GOG_KEYRING_PW=""
  set -a; . "$CRED_DIR/../.env"; set +a
  GOG_KEYRING_PW="${GOG_KEYRING_PASSWORD:-}"
  if [ -n "$GOG_KEYRING_PW" ]; then
    ssh_cmd "grep -q GOG_KEYRING_PASSWORD /sandbox/.env 2>/dev/null && sed -i 's|^GOG_KEYRING_PASSWORD=.*|GOG_KEYRING_PASSWORD=${GOG_KEYRING_PW}|' /sandbox/.env || echo 'GOG_KEYRING_PASSWORD=${GOG_KEYRING_PW}' >> /sandbox/.env; chmod 600 /sandbox/.env"
    info "GOG_KEYRING_PASSWORD injected"
  fi
fi

# Slack webhook URL (per-user only — no host fallback)
if [ -f "$CRED_DIR/slack-webhook-url.txt" ]; then
  USER_SLACK_WEBHOOK="$(cat "$CRED_DIR/slack-webhook-url.txt")"
  ssh_cmd "grep -q SLACK_WEBHOOK_URL /sandbox/.env 2>/dev/null && sed -i 's|^SLACK_WEBHOOK_URL=.*|SLACK_WEBHOOK_URL=${USER_SLACK_WEBHOOK}|' /sandbox/.env || echo 'SLACK_WEBHOOK_URL=${USER_SLACK_WEBHOOK}' >> /sandbox/.env; chmod 600 /sandbox/.env"
  info "Slack webhook URL injected (from user credentials)"
fi

# Slack bot token (for DM-based heartbeat notifications — preferred over webhook)
if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
  ssh_cmd "grep -q SLACK_BOT_TOKEN /sandbox/.env 2>/dev/null && sed -i 's|^SLACK_BOT_TOKEN=.*|SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}|' /sandbox/.env || echo 'SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}' >> /sandbox/.env; chmod 600 /sandbox/.env"
  info "Slack bot token injected"
fi

# Slack user ID (so heartbeat can DM the right user)
if [ -n "$SLACK_USER_ID" ]; then
  ssh_cmd "grep -q SLACK_USER_ID /sandbox/.env 2>/dev/null && sed -i 's|^SLACK_USER_ID=.*|SLACK_USER_ID=${SLACK_USER_ID}|' /sandbox/.env || echo 'SLACK_USER_ID=${SLACK_USER_ID}' >> /sandbox/.env; chmod 600 /sandbox/.env"
  info "Slack user ID injected ($SLACK_USER_ID)"
fi

# slack-notify helper script (DM via bot token, fallback to webhook)
NOTIFY_SCRIPT="$SCRIPT_DIR/slack-notify.sh"
if [ -f "$NOTIFY_SCRIPT" ]; then
  base64 "$NOTIFY_SCRIPT" | ssh_cmd 'mkdir -p /sandbox/.local/bin && base64 -d > /sandbox/.local/bin/slack-notify && chmod +x /sandbox/.local/bin/slack-notify'
  info "slack-notify helper installed"
fi

# ── xurl (X/Twitter) (per-user only — no host fallback) ──────────
if [ -f "$CRED_DIR/xurl-binary" ]; then
  base64 "$CRED_DIR/xurl-binary" | ssh_cmd 'mkdir -p /sandbox/.local/bin && base64 -d > /sandbox/.local/bin/xurl && chmod +x /sandbox/.local/bin/xurl'
  info "xurl binary injected (from user credentials)"
fi

if [ -f "$CRED_DIR/twitter-creds.txt" ]; then
  set -a; . "$CRED_DIR/twitter-creds.txt"; set +a
  ssh_cmd "export PATH='/sandbox/.local/bin:\$PATH' && \
    python3 -c \"import os; f=os.path.expanduser('~/.xurl'); os.path.exists(f) and os.remove(f)\" 2>/dev/null; \
    xurl auth apps add nemoclaw --client-id '${X_API_KEY}' --client-secret '${X_API_KEY_SECRET}' 2>/dev/null; \
    xurl auth oauth1 --consumer-key '${X_API_KEY}' --consumer-secret '${X_API_KEY_SECRET}' --access-token '${X_ACCESS_TOKEN}' --token-secret '${X_ACCESS_TOKEN_SECRET}' 2>/dev/null; \
    xurl auth app --bearer-token '${X_BEARER_TOKEN}' 2>/dev/null; \
    xurl auth default default 2>/dev/null" 2>&1 | grep -v '^\[' || true
  info "xurl (X/Twitter) credentials configured (from user credentials)"
fi

# ── Git config ───────────────────────────────────────────────────
if [ -n "$GITHUB_USER" ]; then
  ssh_cmd "git config --global user.name '${GITHUB_USER}' && git config --global user.email '${GITHUB_EMAIL}'" 2>/dev/null
  info "Git config set (user: $GITHUB_USER)"
fi

# ── uv / uvx (Python package runner) ─────────────────────────────
if ! ssh_cmd 'test -x /root/.local/bin/uvx'; then
  ssh_cmd 'curl -LsSf https://astral.sh/uv/install.sh | sh' 2>/dev/null && info "uv/uvx installed" || warn "uv/uvx install failed"
else
  info "uv/uvx already present"
fi

# ── Shell profile ────────────────────────────────────────────────
ssh_cmd 'cat > /sandbox/.bashrc << "BASHRC"
# NemoClaw sandbox shell profile
export PATH="/sandbox/.local/bin:$PATH"
if [ -f /sandbox/.env ]; then set -a; . /sandbox/.env; set +a; fi
BASHRC
chmod 644 /sandbox/.bashrc'
info "Shell profile created"

# ── Per-user primary inference model ───────────────────────────────
if [ -f "$CRED_DIR/primary-model.txt" ]; then
  PRIMARY_MODEL="$(cat "$CRED_DIR/primary-model.txt" | tr -d '[:space:]')"
  if [ -n "$PRIMARY_MODEL" ]; then
    ssh_cmd "python3 -c \"
import json, os
path = os.path.expanduser('~/.openclaw/openclaw.json')
if not os.path.exists(path) or not os.access(path, os.W_OK): exit(0)
cfg = json.load(open(path))
cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = '${PRIMARY_MODEL}'
json.dump(cfg, open(path, 'w'), indent=2)
os.chmod(path, 0o600)
\"" 2>/dev/null
    info "Primary model set to ${PRIMARY_MODEL}"
  fi
fi

echo ""
info "Credential injection complete for sandbox '${SANDBOX}'"
