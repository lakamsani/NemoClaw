#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Send a Slack notification from inside a sandbox.
#
# Default: Posts a DM to the user via the bot token (SLACK_BOT_TOKEN + SLACK_USER_ID).
# Fallback: Posts via incoming webhook (SLACK_WEBHOOK_URL) if set and bot token is missing.
#
# Usage:
#   slack-notify "Your message here"
#   echo "Your message" | slack-notify
#
# Env (sourced from /sandbox/.env):
#   SLACK_BOT_TOKEN  — Bot User OAuth Token (preferred)
#   SLACK_USER_ID    — Slack user ID to DM (used with bot token)
#   SLACK_WEBHOOK_URL — Incoming webhook URL (fallback)

set -euo pipefail

# Read message from argument or stdin
if [ $# -gt 0 ]; then
  MESSAGE="$*"
else
  MESSAGE="$(cat)"
fi

if [ -z "$MESSAGE" ]; then
  exit 0
fi

# Escape message for JSON
JSON_MESSAGE=$(printf '%s' "$MESSAGE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$MESSAGE")

# Method 1: Bot token + user ID → DM the user directly
if [ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${SLACK_USER_ID:-}" ]; then
  # Open a DM channel with the user
  DM_RESPONSE=$(curl -s -X POST "https://slack.com/api/conversations.open" \
    -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"users\":\"${SLACK_USER_ID}\"}" 2>/dev/null)

  DM_CHANNEL=$(echo "$DM_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('channel',{}).get('id',''))" 2>/dev/null || true)

  if [ -n "$DM_CHANNEL" ]; then
    curl -s -X POST "https://slack.com/api/chat.postMessage" \
      -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"channel\":\"${DM_CHANNEL}\",\"text\":${JSON_MESSAGE}}" > /dev/null 2>&1
    exit 0
  fi
fi

# Method 2: Webhook fallback
if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  echo "{\"text\":${JSON_MESSAGE}}" | curl -s -X POST -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK_URL" > /dev/null 2>&1
  exit 0
fi

echo "[slack-notify] No SLACK_BOT_TOKEN+SLACK_USER_ID or SLACK_WEBHOOK_URL set — message not sent" >&2
exit 1
