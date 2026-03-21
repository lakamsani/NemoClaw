#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Create the OpenClaw heartbeat cron job inside a sandbox.
# Idempotent — skips if heartbeat job already exists.
#
# Usage:
#   ./scripts/setup-heartbeat-cron.sh [sandbox-name]
#   SSH_CONF=/tmp/ssh-config-foo ./scripts/setup-heartbeat-cron.sh foo

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$REPO_DIR/.env" ]; then
  set -a; . "$REPO_DIR/.env"; set +a
fi

SANDBOX="${1:-${NEMOCLAW_SANDBOX:-veyonce-claw}}"
SSH_CONF="${SSH_CONF:-/tmp/ssh-config-${SANDBOX}}"

# Generate SSH config if not present
if [ ! -f "$SSH_CONF" ]; then
  openshell sandbox ssh-config "$SANDBOX" > "$SSH_CONF" 2>/dev/null
fi

ssh_cmd() {
  ssh -F "$SSH_CONF" -o StrictHostKeyChecking=no -o ConnectTimeout=5 "openshell-${SANDBOX}" "$@"
}

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

# Create heartbeat cron job
read -r -d '' HEARTBEAT_MSG << 'HEARTBEAT_EOF' || true
You are a personal assistant for Vamsee (timezone: US Pacific / PDT, UTC-7).
IMPORTANT: The sandbox runs in UTC. Calendar events show PDT times (-07:00). Convert to compare with current time correctly.

Run these steps in order:

Step 1: Source environment and get current time in Pacific.
Run: set -a && source /sandbox/.env && set +a && export PATH=/sandbox/.local/bin:$PATH && TZ=America/Los_Angeles date

Step 2: Check Gmail for important unread emails.
Run: gog gmail list -a lakamsani@gmail.com "is:unread" --max 10
If any look important (from real people, not promo/spam/newsletters), note them.

Step 3: Check Calendar for upcoming events in next 30 minutes.
Run: gog calendar events -a lakamsani@gmail.com --today --max 10
Compare event start times against the CURRENT Pacific time from Step 1. If any event starts within 30 minutes from now, note it.

Step 4: If you found important emails or upcoming events, send a Slack notification for each:
Run: slack-notify "<your message>"
This DMs the user directly via the Slack bot. Falls back to webhook if configured.

If nothing needs attention, reply HEARTBEAT_OK.
HEARTBEAT_EOF

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

echo "[heartbeat-cron] Heartbeat cron job created (every 30m)"
