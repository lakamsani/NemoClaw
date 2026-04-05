#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Forward emoji-prefixed Slack bot DMs to WhatsApp.
# Runs on host cron every 5 minutes. Reads recent bot messages from
# each user's DM channel and forwards new ones to WhatsApp.
#
# Usage: forward-slack-to-whatsapp.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_FILE="/tmp/nemoclaw-wa-forward-state.json"

# Source .env
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$REPO_DIR/.env"
  set +a
fi

[ -n "${SLACK_BOT_TOKEN:-}" ] || exit 0

# Initialize state file
[ -f "$STATE_FILE" ] || echo '{}' > "$STATE_FILE"

# Get bot user ID
BOT_USER_ID=$(/usr/bin/curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/auth.test" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_id',''))" 2>/dev/null)

[ -n "$BOT_USER_ID" ] || exit 0

# Load user registry
USERS_FILE="$HOME/.nemoclaw/users.json"
[ -f "$USERS_FILE" ] || exit 0

# For each user with a WhatsApp number
python3 -c "
import json, os, sys, subprocess, time

repo = '$REPO_DIR'
bot_token = '$SLACK_BOT_TOKEN'
bot_user_id = '$BOT_USER_ID'
state_file = '$STATE_FILE'

users = json.load(open('$USERS_FILE')).get('users', {})
state = json.load(open(state_file))

for slack_id, user in users.items():
    if not user.get('enabled', True):
        continue

    wa_file = os.path.join(repo, 'persist', 'users', slack_id, 'credentials', 'whatsapp-number.txt')
    if not os.path.exists(wa_file):
        continue
    wa_number = open(wa_file).read().strip()
    if not wa_number:
        continue

    # Open DM channel with user
    import urllib.request, urllib.parse
    headers = {'Authorization': f'Bearer {bot_token}', 'Content-Type': 'application/json'}
    req = urllib.request.Request(
        'https://slack.com/api/conversations.open',
        data=json.dumps({'users': slack_id}).encode(),
        headers=headers
    )
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
        dm_channel = resp.get('channel', {}).get('id', '')
    except:
        continue
    if not dm_channel:
        continue

    # Get recent messages from bot in this DM (last 5 minutes)
    last_ts = state.get(slack_id, '0')
    req = urllib.request.Request(
        f'https://slack.com/api/conversations.history?channel={dm_channel}&limit=10&oldest={last_ts}',
        headers=headers
    )
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
        messages = resp.get('messages', [])
    except:
        continue

    # Filter: only bot messages with emoji prefix
    # Match both Unicode emoji and Slack :emoji: notation
    emoji_re = __import__('re').compile(r'^(:[a-z_]+:|[\U0001F4E7\U0001F4C5\U000023F0\U0001F514\U000026A0\U00002757\U0001F6A8\U0001F4CC\U0001F4CB\U00002705\U0001F198\U0001F534\U0001F7E1\U0001F7E2])')

    max_ts = last_ts
    for msg in reversed(messages):
        ts = msg.get('ts', '0')
        if float(ts) <= float(last_ts):
            continue
        if ts > max_ts:
            max_ts = ts

        # Only forward bot's own messages
        if msg.get('user') != bot_user_id and msg.get('bot_id') is None:
            continue

        text = msg.get('text', '')
        if not text or not emoji_re.match(text):
            continue

        # Convert Slack emoji to Unicode and strip mrkdwn for WhatsApp
        import re as _re
        slack_emoji = {
            ':clipboard:': '\U0001F4CB', ':email:': '\U0001F4E7', ':calendar:': '\U0001F4C5',
            ':alarm_clock:': '\U000023F0', ':bell:': '\U0001F514', ':warning:': '\U000026A0',
            ':exclamation:': '\U00002757', ':rotating_light:': '\U0001F6A8', ':pushpin:': '\U0001F4CC',
            ':white_check_mark:': '\U00002705', ':sos:': '\U0001F198', ':red_circle:': '\U0001F534',
            ':large_yellow_circle:': '\U0001F7E1', ':large_green_circle:': '\U0001F7E2',
            ':memo:': '\U0001F4DD', ':mailbox:': '\U0001F4EB',
        }
        plain = text
        for k, v in slack_emoji.items():
            plain = plain.replace(k, v)
        # Strip remaining :emoji: notation
        plain = _re.sub(r':[a-z_]+:', '', plain)
        plain = plain.replace('*', '').strip()
        if len(plain) < 5:
            continue

        # Send to WhatsApp
        try:
            env = dict(os.environ)
            env['SLACK_USER_ID'] = slack_id
            subprocess.run(
                ['node', os.path.join(repo, 'scripts', 'whatsapp-bridge.js'), 'send', wa_number, plain],
                env=env, timeout=30, capture_output=True
            )
            print(f'[wa-forward] Forwarded to {wa_number} for {user.get(\"slackDisplayName\", slack_id)}')
        except:
            pass

    if max_ts != last_ts:
        state[slack_id] = max_ts

json.dump(state, open(state_file, 'w'))
" 2>/dev/null
