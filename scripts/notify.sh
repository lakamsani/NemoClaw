#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Send a notification to a user via Slack DM AND WhatsApp.
#
# Usage: notify.sh <slack-user-id> <message>
# Env: SLACK_BOT_TOKEN (from .env), REPO_DIR or auto-detected

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

SLACK_USER_ID="${1:-}"
MESSAGE="${2:-}"

if [ -z "$SLACK_USER_ID" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: notify.sh <slack-user-id> <message>" >&2
  exit 1
fi

# Source .env for tokens
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$REPO_DIR/.env"
  set +a
fi

# ── Slack DM ──────────────────────────────────────────────────────
if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
  DM_CHANNEL=$(/usr/bin/curl -s -X POST \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"users\":\"$SLACK_USER_ID\"}" \
    "https://slack.com/api/conversations.open" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('channel',{}).get('id',''))" 2>/dev/null)

  if [ -n "$DM_CHANNEL" ]; then
    ESCAPED_MSG=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read().strip()))" <<< "$MESSAGE")
    /usr/bin/curl -s -X POST \
      -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"channel\":\"$DM_CHANNEL\",\"text\":$ESCAPED_MSG}" \
      "https://slack.com/api/chat.postMessage" >/dev/null 2>&1
  fi
fi

# ── WhatsApp ──────────────────────────────────────────────────────
# Look up user's WhatsApp number from persist config
WA_CONFIG="$REPO_DIR/persist/users/$SLACK_USER_ID/credentials/whatsapp-number.txt"
if [ -f "$WA_CONFIG" ]; then
  WA_NUMBER=$(cat "$WA_CONFIG" | tr -d '[:space:]')
  if [ -n "$WA_NUMBER" ]; then
    # Strip markdown bold for WhatsApp (plain text)
    WA_MESSAGE=$(echo "$MESSAGE" | sed 's/\*//g')
    SLACK_USER_ID="$SLACK_USER_ID" timeout 30 node "$SCRIPT_DIR/whatsapp-bridge.js" send "$WA_NUMBER" "$WA_MESSAGE" >/dev/null 2>&1 || true
  fi
fi
