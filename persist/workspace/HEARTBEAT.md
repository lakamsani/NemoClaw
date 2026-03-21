# HEARTBEAT.md

## Checklist (run every heartbeat, ~30 min)

### 0. Setup — Source environment
- Run first: `set -a && source /sandbox/.env && set +a && export PATH="/sandbox/.local/bin:$PATH"`
- This sets GOG_KEYRING_PASSWORD (needed for gog auth) and SLACK_WEBHOOK_URL.

### 1. Gmail — Check for important unread emails
- Run: `gog gmail list -a YOUR_EMAIL "is:unread" --max 10`
- If any look important (from real people, not promo/spam/newsletters), send a Slack notification with sender, subject, and a 1-line summary.
- Skip newsletters, marketing, automated notifications unless they look urgent.

### 2. Calendar — Upcoming events in next 30 minutes
- Run: `gog calendar events -a YOUR_EMAIL --from now --to "+30m" --max 5`
- If `--to "+30m"` does not work, use `--today` and filter events starting within 30 minutes manually.
- If any event starts within the next 30 minutes, send a Slack notification with the event title, time, and location/link.
- Do NOT notify for events more than 30 minutes away — they will get caught in the next heartbeat.

### 3. Send Slack notifications
- Env already sourced in step 0.
- Send via: `echo '{"text":"<message>"}' | curl -s -X POST -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK_URL"`
- Keep messages concise and useful. One message per notification.
- If nothing needs attention, do NOT send a Slack message.

## Rules
- If nothing needs attention across all checks, reply `HEARTBEAT_OK` — no Slack message needed.
- Track last check timestamps in `memory/heartbeat-state.json` to avoid duplicate notifications.
- Respect quiet hours (11 PM - 8 AM Pacific) — only notify for truly urgent items during these hours.
- Never send duplicate notifications for the same email or event within the same day.
