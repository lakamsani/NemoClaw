#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Copy credentials from host into the NemoClaw sandbox.
# Re-run after sandbox restarts or token refreshes.
#
# Usage:
#   ./scripts/inject-credentials.sh [sandbox-name]

set -euo pipefail

SANDBOX="${1:-${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-my-assistant}}}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[inject]${NC} $1"; }
warn()  { echo -e "${YELLOW}[inject]${NC} $1"; }
fail()  { echo -e "${RED}[inject]${NC} $1"; exit 1; }

ssh_cmd() {
  ssh -o StrictHostKeyChecking=no "openshell-${SANDBOX}" "$@"
}

scp_to() {
  local src="$1" dst="$2"
  scp -o StrictHostKeyChecking=no "$src" "openshell-${SANDBOX}:${dst}"
}

# Ensure target directories exist
ssh_cmd 'mkdir -p /sandbox/.claude /sandbox/.config/gh'

# ── Claude Code credentials ──────────────────────────────────────
if [ -f "$HOME/.claude/.credentials.json" ]; then
  scp_to "$HOME/.claude/.credentials.json" "/sandbox/.claude/.credentials.json"
  ssh_cmd 'chmod 600 /sandbox/.claude/.credentials.json'
  info "Claude credentials copied"
else
  warn "No Claude credentials found at ~/.claude/.credentials.json"
fi

if [ -f "$HOME/.claude/settings.json" ]; then
  scp_to "$HOME/.claude/settings.json" "/sandbox/.claude/settings.json"
  info "Claude settings copied"
else
  warn "No Claude settings found at ~/.claude/settings.json"
fi

# ── Claude MCP auth cache ────────────────────────────────────────
if [ -f "$HOME/.claude/mcp-needs-auth-cache.json" ]; then
  scp_to "$HOME/.claude/mcp-needs-auth-cache.json" "/sandbox/.claude/mcp-needs-auth-cache.json"
  info "Claude MCP auth cache copied"
else
  warn "No MCP auth cache found — Google/Slack MCP tools may need re-auth"
fi

# ── GitHub token ─────────────────────────────────────────────────
GH_TOKEN="${GH_TOKEN:-}"
if [ -z "$GH_TOKEN" ] && command -v gh > /dev/null 2>&1; then
  GH_TOKEN="$(gh auth token 2>/dev/null || true)"
fi

if [ -n "$GH_TOKEN" ]; then
  ssh_cmd "cat > /sandbox/.config/gh/hosts.yml" <<EOF
github.com:
  oauth_token: ${GH_TOKEN}
  user: lakamsani
  git_protocol: https
EOF
  ssh_cmd 'chmod 600 /sandbox/.config/gh/hosts.yml'
  info "GitHub token injected"
else
  warn "No GH_TOKEN found — set GH_TOKEN or run 'gh auth login' first"
fi

# ── Google service account credential ─────────────────────────────
GOOGLE_SA_PATH="${GOOGLE_APPLICATION_CREDENTIALS:-$HOME/lakmsani-gmail-service-account.json}"
if [ -f "$GOOGLE_SA_PATH" ]; then
  ssh_cmd 'mkdir -p /sandbox/.config/gcloud'
  scp_to "$GOOGLE_SA_PATH" "/sandbox/.config/gcloud/service-account.json"
  ssh_cmd 'chmod 600 /sandbox/.config/gcloud/service-account.json'
  ssh_cmd "echo 'export GOOGLE_APPLICATION_CREDENTIALS=/sandbox/.config/gcloud/service-account.json' >> /sandbox/.bashrc"
  info "Google service account credential copied"
else
  warn "No Google service account found at $GOOGLE_SA_PATH"
fi

# ── gog CLI (Google OAuth) credentials ───────────────────────────
if [ -d "$HOME/.config/gogcli" ]; then
  ssh_cmd 'mkdir -p /sandbox/.config/gogcli'
  for f in config.json credentials.json; do
    if [ -f "$HOME/.config/gogcli/$f" ]; then
      scp_to "$HOME/.config/gogcli/$f" "/sandbox/.config/gogcli/$f"
    fi
  done
  # Copy keyring and tokens directories
  for d in keyring tokens; do
    if [ -d "$HOME/.config/gogcli/$d" ]; then
      ssh_cmd "mkdir -p /sandbox/.config/gogcli/$d"
      for f in "$HOME/.config/gogcli/$d"/*; do
        [ -f "$f" ] && scp_to "$f" "/sandbox/.config/gogcli/$d/$(basename "$f")"
      done
    fi
  done
  ssh_cmd 'chmod -R 700 /sandbox/.config/gogcli'
  info "gog OAuth credentials copied"
else
  warn "No gog config found at ~/.config/gogcli — Google OAuth tools won't work"
fi

# ── gog keyring password (for headless/heartbeat use) ────────────
GOG_KEYRING_PW="${GOG_KEYRING_PASSWORD:-nemoclaw}"
ssh_cmd "grep -q GOG_KEYRING_PASSWORD /sandbox/.env 2>/dev/null && sed -i 's|^GOG_KEYRING_PASSWORD=.*|GOG_KEYRING_PASSWORD=${GOG_KEYRING_PW}|' /sandbox/.env || echo 'GOG_KEYRING_PASSWORD=${GOG_KEYRING_PW}' >> /sandbox/.env; chmod 600 /sandbox/.env"
info "GOG_KEYRING_PASSWORD injected into /sandbox/.env"

# ── Git config ───────────────────────────────────────────────────
ssh_cmd 'git config --global user.name "lakamsani" && git config --global user.email "lakamsani@users.noreply.github.com"'
info "Git config set"

echo ""
info "Credential injection complete for sandbox '${SANDBOX}'"
info "Verify with:"
info "  ssh openshell-${SANDBOX} 'claude --version'"
info "  ssh openshell-${SANDBOX} 'gh auth status'"
info "  ssh openshell-${SANDBOX} 'gog auth status'"
