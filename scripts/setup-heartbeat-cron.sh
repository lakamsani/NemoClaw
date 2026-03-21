#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Create the OpenClaw heartbeat cron job inside a sandbox.
# Idempotent — skips if heartbeat job already exists.
# Reads heartbeat prompt from per-user HEARTBEAT.md; skips if empty/comments-only.
#
# Usage:
#   ./scripts/setup-heartbeat-cron.sh [sandbox-name]
#   SSH_CONF=/tmp/ssh-config-foo ./scripts/setup-heartbeat-cron.sh foo
#   ./scripts/setup-heartbeat-cron.sh foo --slack-user-id U09R681EPQ9

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$REPO_DIR/.env" ]; then
  set -a; . "$REPO_DIR/.env"; set +a
fi

SANDBOX=""
SLACK_USER_ID=""

while [ $# -gt 0 ]; do
  case "$1" in
    --slack-user-id) SLACK_USER_ID="${2:?--slack-user-id requires a value}"; shift 2 ;;
    -*) shift ;;
    *)
      if [ -z "$SANDBOX" ]; then
        SANDBOX="$1"
      fi
      shift
      ;;
  esac
done

SANDBOX="${SANDBOX:-${NEMOCLAW_SANDBOX:-veyonce-claw}}"
SSH_CONF="${SSH_CONF:-/tmp/ssh-config-${SANDBOX}}"

# Generate SSH config if not present
if [ ! -f "$SSH_CONF" ]; then
  openshell sandbox ssh-config "$SANDBOX" > "$SSH_CONF" 2>/dev/null
fi

ssh_cmd() {
  ssh -F "$SSH_CONF" -o StrictHostKeyChecking=no -o ConnectTimeout=5 "openshell-${SANDBOX}" "$@"
}

# ── Resolve heartbeat prompt from per-user HEARTBEAT.md ──────────
HEARTBEAT_MSG=""

# Try per-user file first (requires SLACK_USER_ID)
if [ -n "$SLACK_USER_ID" ]; then
  HB_FILE="$REPO_DIR/persist/users/$SLACK_USER_ID/workspace/HEARTBEAT.md"
  if [ -f "$HB_FILE" ]; then
    # Strip comment lines and blank lines, check if anything remains
    CONTENT="$(grep -v '^\s*#' "$HB_FILE" | grep -v '^\s*$' || true)"
    if [ -n "$CONTENT" ]; then
      HEARTBEAT_MSG="$CONTENT"
    fi
  fi
fi

# Fallback: try sandbox-level default (legacy)
if [ -z "$HEARTBEAT_MSG" ] && [ -z "$SLACK_USER_ID" ]; then
  HB_FILE="$REPO_DIR/persist/workspace/HEARTBEAT.md"
  if [ -f "$HB_FILE" ]; then
    CONTENT="$(grep -v '^\s*#' "$HB_FILE" | grep -v '^\s*$' || true)"
    if [ -n "$CONTENT" ]; then
      HEARTBEAT_MSG="$CONTENT"
    fi
  fi
fi

if [ -z "$HEARTBEAT_MSG" ]; then
  echo "[heartbeat-cron] No heartbeat prompt found for $SANDBOX (HEARTBEAT.md empty or missing), skipping"
  exit 0
fi

# Check if heartbeat cron already exists
if ssh_cmd 'export HOME=/sandbox; openclaw cron list 2>/dev/null | grep -q heartbeat'; then
  echo "[heartbeat-cron] Already exists, skipping"
  exit 0
fi

# Wait for gateway
echo "[heartbeat-cron] Waiting for gateway..."
for i in $(seq 1 15); do
  if ssh_cmd 'export HOME=/sandbox; openclaw cron list >/dev/null 2>&1'; then
    break
  fi
  if [ "$i" -eq 15 ]; then
    echo "[heartbeat-cron] Gateway not ready after 30s, aborting"
    exit 1
  fi
  sleep 2
done

# Write message to temp file, copy to sandbox, create cron from there
TMPFILE="$(mktemp)"
echo "$HEARTBEAT_MSG" > "$TMPFILE"
cat "$TMPFILE" | ssh_cmd 'cat > /tmp/heartbeat-msg.txt'
rm -f "$TMPFILE"

ssh_cmd 'export HOME=/sandbox; openclaw cron add \
  --name heartbeat \
  --every 30m \
  --agent main \
  --session isolated \
  --message "$(cat /tmp/heartbeat-msg.txt)" \
  --timeout-seconds 180 \
  --no-deliver \
  2>&1 && rm -f /tmp/heartbeat-msg.txt'

echo "[heartbeat-cron] Heartbeat cron job created (every 30m) for $SANDBOX"
