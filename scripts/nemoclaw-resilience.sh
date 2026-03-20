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

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source .env
if [ -f "$REPO_DIR/.env" ]; then
  set -a; . "$REPO_DIR/.env"; set +a
fi

SANDBOX="${NEMOCLAW_SANDBOX:-veyonce-claw}"

# Parse args
while [ $# -gt 0 ]; do
  case "$1" in
    --sandbox) SANDBOX="${2:?--sandbox requires a name}"; shift 2 ;;
    *) shift ;;
  esac
done

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
for preset in google.yaml xcurl.yaml slack.yaml; do
  [ -f "$POLICY_DIR/presets/$preset" ] && PRESETS+=("$POLICY_DIR/presets/$preset")
done

python3 "$SCRIPT_DIR/merge-policy.py" \
  "$POLICY_DIR/openclaw-sandbox.yaml" \
  "${PRESETS[@]}" \
  > /tmp/nemoclaw-merged-policy.yaml

openshell policy set --policy /tmp/nemoclaw-merged-policy.yaml "$SANDBOX" 2>&1 | tail -1
info "Network policy applied"

# ── Step 4: Inject credentials ───────────────────────────────────
# Claude credentials (base64 over SSH — sftp is broken in sandbox)
if [ -f "$HOME/.claude/.credentials.json" ]; then
  ssh_cmd 'mkdir -p /sandbox/.claude'
  base64 "$HOME/.claude/.credentials.json" | ssh_cmd 'base64 -d > /sandbox/.claude/.credentials.json && chmod 600 /sandbox/.claude/.credentials.json'
  info "Claude credentials injected"

  # Extract ANTHROPIC_API_KEY for openclaw config
  ANTHROPIC_API_KEY="$(python3 -c "import json; d=json.load(open('$HOME/.claude/.credentials.json')); print(d.get('claudeAiOauth',{}).get('accessToken',''))" 2>/dev/null || true)"
else
  warn "No Claude credentials at ~/.claude/.credentials.json"
fi

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

# xurl config (X/Twitter) — write from twitter-claw.txt tokens via xurl CLI
XURL_BIN="$REPO_DIR/persist/xurl-linux-arm64"
if [ -f "$XURL_BIN" ]; then
  base64 "$XURL_BIN" | ssh_cmd 'mkdir -p /sandbox/.local/bin && base64 -d > /sandbox/.local/bin/xurl && chmod +x /sandbox/.local/bin/xurl'
  info "xurl binary injected"
fi

TWITTER_CREDS="${TWITTER_CREDS_PATH:-$HOME/twitter-claw.txt}"
if [ -f "$TWITTER_CREDS" ]; then
  # Source twitter tokens and configure xurl inside sandbox
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

# Slack webhook URL (for heartbeat notifications)
if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  ssh_cmd "grep -q SLACK_WEBHOOK_URL /sandbox/.env 2>/dev/null && sed -i 's|^SLACK_WEBHOOK_URL=.*|SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}|' /sandbox/.env || echo 'SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}' >> /sandbox/.env"
  ssh_cmd 'chmod 600 /sandbox/.env'
  info "Slack webhook URL injected"
fi

# ── Step 5: Patch OpenClaw config with Anthropic ─────────────────
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  GATEWAY_TOKEN="${GATEWAY_AUTH_TOKEN:-7e4d602a8db8d4ca328c538d293e3ac69f365a2d7db89fbb}"
  ssh_cmd "python3 -c \"
import json, os
# Patch openclaw.json
path = os.path.expanduser('~/.openclaw/openclaw.json')
cfg = json.load(open(path))
providers = cfg.setdefault('models', {}).setdefault('providers', {})
if 'anthropic' not in providers:
    providers['anthropic'] = {'baseUrl': 'https://api.anthropic.com/v1', 'api': 'anthropic-messages', 'models': [{'id': 'claude-sonnet-4-6', 'name': 'Claude Sonnet 4.6', 'reasoning': False, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 200000, 'maxTokens': 64000}]}
providers['anthropic']['apiKey'] = '${ANTHROPIC_API_KEY}'
cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = 'anthropic/claude-sonnet-4-6'
# Gateway auth token for Control UI
gw = cfg.setdefault('gateway', {})
gw['auth'] = {'mode': 'token', 'token': '${GATEWAY_TOKEN}'}
gw['controlUi'] = {'allowInsecureAuth': True, 'dangerouslyDisableDeviceAuth': True, 'allowedOrigins': ['http://127.0.0.1:18789', 'http://localhost:18789']}
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

# ── Step 6: Restore workspace personality files ──────────────────
PERSIST_DIR="$REPO_DIR/persist/workspace"
if [ -d "$PERSIST_DIR" ] && [ -f "$PERSIST_DIR/SOUL.md" ]; then
  cd "$PERSIST_DIR" && tar czf - . | ssh_cmd 'tar xzf - -C /sandbox/.openclaw/workspace/'
  cd "$REPO_DIR"
  info "Workspace personality files restored"
else
  warn "No workspace backup at $PERSIST_DIR"
fi

# ── Step 7: Restore cron jobs ──────────────────────────────────
"$SCRIPT_DIR/setup-cron.sh" 2>&1 | grep '\[cron\]' || true
info "Cron jobs restored"

# ── Step 8: Start Slack bridge ───────────────────────────────────
"$SCRIPT_DIR/start-services.sh" --sandbox "$SANDBOX" 2>&1 | grep -E '\[services\]|┌|│|└'
info "Services started"

echo ""
info "NemoClaw fully operational — sandbox: $SANDBOX"
