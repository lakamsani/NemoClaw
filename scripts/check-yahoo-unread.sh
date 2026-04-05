#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Check Yahoo unread emails and notify via Slack if any important ones found.
# Designed to run from cron alongside the heartbeat.
#
# Usage: check-yahoo-unread.sh <slack-user-id>

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SLACK_USER_ID="${1:-}"
if [ -z "$SLACK_USER_ID" ]; then
  echo "Usage: check-yahoo-unread.sh <slack-user-id>" >&2
  exit 1
fi

# Source .env for Slack tokens
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$REPO_DIR/.env"
  set +a
fi

CREDS_FILE="$REPO_DIR/persist/users/$SLACK_USER_ID/credentials/yahoo-creds.env"
if [ ! -f "$CREDS_FILE" ]; then
  exit 0  # No Yahoo credentials — skip silently
fi

# Load Yahoo credentials
set -a
# shellcheck source=/dev/null
. "$CREDS_FILE"
set +a

# Check unread count
UNREAD_OUTPUT=$(python3 "$SCRIPT_DIR/yahoo-mail.py" inbox --count 5 --unread 2>&1) || true

if echo "$UNREAD_OUTPUT" | grep -q "No messages found"; then
  exit 0
fi

# Count unread messages (subtract header + separator lines)
UNREAD_COUNT=$(echo "$UNREAD_OUTPUT" | tail -n +3 | grep -c "." || true)

if [ "$UNREAD_COUNT" -eq 0 ]; then
  exit 0
fi

# Format notification
SUMMARY=$(echo "$UNREAD_OUTPUT" | tail -n +3 | head -5 | while IFS= read -r line; do
  # Extract subject from the fixed-width output
  subj=$(echo "$line" | sed 's/^.\{60\}//' | xargs)
  from=$(echo "$line" | cut -c9-38 | xargs)
  [ -n "$subj" ] && echo "• $from: $subj"
done)

if [ -z "$SUMMARY" ]; then
  exit 0
fi

MESSAGE="📧 *Yahoo Mail* — $UNREAD_COUNT unread:
$SUMMARY"

# Send via Slack + WhatsApp
"$SCRIPT_DIR/notify.sh" "$SLACK_USER_ID" "$MESSAGE"
