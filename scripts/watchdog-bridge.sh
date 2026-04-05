#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Watchdog: restart Slack bridge if it's not running.
# Designed to run from cron every 2 minutes.
#
# Usage:
#   */2 * * * * /path/to/watchdog-bridge.sh >> /tmp/nemoclaw-watchdog.log 2>&1

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SANDBOX_NAME="${NEMOCLAW_SANDBOX:-veyonce-claw}"
PIDDIR="/tmp/nemoclaw-services-${SANDBOX_NAME}"
PIDFILE="$PIDDIR/slack-bridge.pid"
LOGFILE="$PIDDIR/slack-bridge.log"

ts() { date "+%Y-%m-%d %H:%M:%S"; }

# Source .env for tokens
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$REPO_DIR/.env"
  set +a
fi

# Check if bridge is running
bridge_alive() {
  if [ -f "$PIDFILE" ]; then
    local pid
    pid="$(cat "$PIDFILE")"
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  # Fallback: look for the process by pattern
  if pgrep -f "node.*slack-bridge(-multi)?\\.js" >/dev/null 2>&1; then
    # Update PID file with actual PID
    local pid
    pid="$(pgrep -fo "node.*slack-bridge(-multi)\\.js" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
      mkdir -p "$PIDDIR"
      echo "$pid" > "$PIDFILE"
      return 0
    fi
  fi
  return 1
}

if bridge_alive; then
  exit 0
fi

# Bridge is down — restart
echo "$(ts) [watchdog] Bridge not running, restarting..."

# Verify tokens are available
if [ -z "${SLACK_BOT_TOKEN:-}" ] || [ -z "${SLACK_APP_TOKEN:-}" ]; then
  echo "$(ts) [watchdog] ERROR: SLACK_BOT_TOKEN or SLACK_APP_TOKEN missing from .env"
  exit 1
fi

mkdir -p "$PIDDIR"

# Determine which bridge script to use
USERS_FILE="$HOME/.nemoclaw/users.json"
if [ -f "$USERS_FILE" ] && python3 -c "import json; d=json.load(open('$USERS_FILE')); exit(0 if len(d.get('users',{})) > 0 else 1)" 2>/dev/null; then
  BRIDGE_SCRIPT="$REPO_DIR/scripts/slack-bridge-multi.js"
else
  BRIDGE_SCRIPT="$REPO_DIR/scripts/slack-bridge.js"
fi

# Fix root-owned files and clean stale locks in all sandboxes
if [ -f "$USERS_FILE" ]; then
  for sandbox in $(python3 -c "
import json
d = json.load(open('$USERS_FILE'))
for u in d.get('users', {}).values():
  if u.get('enabled', True):
    print(u.get('sandboxName', ''))
" 2>/dev/null); do
    if [ -n "$sandbox" ]; then
      # Fix root-owned files via kubectl (runs as root inside the pod)
      docker exec openshell-cluster-nemoclaw kubectl exec -n openshell "$sandbox" -- \
        sh -c 'chown -R sandbox:sandbox /sandbox/.openclaw 2>/dev/null; chmod -R u+w /sandbox/.openclaw 2>/dev/null' \
        2>/dev/null || true
      # Clean stale session locks via SSH
      openshell sandbox ssh-config "$sandbox" > "/tmp/watchdog-ssh-$sandbox" 2>/dev/null || continue
      ssh -F "/tmp/watchdog-ssh-$sandbox" "openshell-$sandbox" \
        'find /sandbox/.openclaw/agents -name "*.lock" -mmin +2 -delete 2>/dev/null' \
        2>/dev/null || true
      rm -f "/tmp/watchdog-ssh-$sandbox"
    fi
  done
  echo "$(ts) [watchdog] Fixed ownership and cleaned stale locks"
fi

# Kill any zombie bridge processes
pkill -f "node.*slack-bridge(-multi)?\\.js" 2>/dev/null || true
sleep 1

# Start bridge
nohup node "$BRIDGE_SCRIPT" >> "$LOGFILE" 2>&1 &
BRIDGE_PID=$!
echo "$BRIDGE_PID" > "$PIDFILE"

sleep 3

if kill -0 "$BRIDGE_PID" 2>/dev/null; then
  echo "$(ts) [watchdog] Bridge restarted (PID $BRIDGE_PID)"
else
  echo "$(ts) [watchdog] ERROR: Bridge failed to start. Check $LOGFILE"
fi

# ── WhatsApp bridge watchdog ──────────────────────────────────────
WA_PIDFILE="$PIDDIR/whatsapp-bridge.pid"
WA_LOGFILE="$PIDDIR/whatsapp-bridge.log"
WA_AUTH="$REPO_DIR/persist/gateway/whatsapp-auth/creds.json"
WA_FALLBACK="/tmp/wa-login/auth/creds.json"

wa_alive() {
  if [ -f "$WA_PIDFILE" ]; then
    local pid
    pid="$(cat "$WA_PIDFILE")"
    kill -0 "$pid" 2>/dev/null && return 0
  fi
  if pgrep -f "node.*whatsapp-bridge-multi\\.js" >/dev/null 2>&1; then
    pgrep -fo "node.*whatsapp-bridge-multi\\.js" > "$WA_PIDFILE" 2>/dev/null
    return 0
  fi
  return 1
}

if [ -f "$WA_AUTH" ] || [ -f "$WA_FALLBACK" ]; then
  if ! wa_alive; then
    echo "$(ts) [watchdog] WhatsApp bridge not running, restarting..."
    pkill -f "node.*whatsapp-bridge-multi\\.js" 2>/dev/null || true
    sleep 1
    nohup node "$REPO_DIR/scripts/whatsapp-bridge-multi.js" >> "$WA_LOGFILE" 2>&1 &
    WA_PID=$!
    echo "$WA_PID" > "$WA_PIDFILE"
    sleep 3
    if kill -0 "$WA_PID" 2>/dev/null; then
      echo "$(ts) [watchdog] WhatsApp bridge restarted (PID $WA_PID)"
    else
      echo "$(ts) [watchdog] ERROR: WhatsApp bridge failed to start. Check $WA_LOGFILE"
    fi
  fi
fi
