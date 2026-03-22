---
description: Register a new NemoClaw user and bring up their sandbox
argument-hint: <slack_id> <display_name> <claw_name> <github_handle>
---

## Add a new NemoClaw claw (user + sandbox)

Four arguments are required (from $ARGUMENTS, space-separated):

1. **Slack user ID** (e.g. U09R681EPQ9)
2. **Display name** (e.g. "Alice Smith" — may be quoted)
3. **Claw/sandbox name** (e.g. alice-claw)
4. **GitHub handle** (e.g. alice)

### Step 1: Validate

All four arguments are required. If any are missing, stop and show:
```
Usage: /add-claw <slack_id> <display_name> <claw_name> <github_handle>
Example: /add-claw U12345ABC "Jane Doe" jane-claw janedoe
```

Verify:
- slack_id starts with `U` followed by uppercase alphanumeric
- claw_name is lowercase letters, numbers, and hyphens
- display_name and github_handle are non-empty

### Step 2: Register user and create sandbox

Run from the repo root (`/home/vamsee/NemoClaw-multi-user-claude`):

```bash
node bin/nemoclaw.js user-add --non-interactive \
  --slack-id "<slack_id>" \
  --display-name "<display_name>" \
  --claw-name "<claw_name>" \
  --github-user "<github_handle>"
```

If this fails, report the error and stop.

### Step 3: Full bring-up with resilience script

After user-add succeeds, run the resilience script to inject credentials, apply the full merged policy, start the gateway, and restore workspace files:

```bash
bash scripts/nemoclaw-resilience.sh \
  --sandbox "<claw_name>" \
  --cred-dir "persist/users/<slack_id>/credentials" \
  --github-user "<github_handle>" \
  --slack-user-id "<slack_id>"
```

This may take a few minutes. Show progress to the user.

### Step 4: Restart the Slack bridge

The Slack bridge loads the user registry once at startup. After adding a new user, restart it so the new claw can receive Slack messages:

```bash
bash scripts/start-services.sh restart
```

Verify the bridge is running after restart.

### Step 5: Report results

Summarize:
- User registered: display_name (slack_id)
- Sandbox created: claw_name
- GitHub: github_handle
- Policy applied, credentials injected, gateway started

If any step had warnings, report them.
