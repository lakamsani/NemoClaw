---
name: add-claw
description: Register a new NemoClaw user, create their sandbox, and bring it up on the current DGX multi-user deployment. Use when asked to add a claw, create a claw, provision a new user sandbox, or onboard a Slack user into the current NemoClaw deployment.
---

# Add Claw

This skill creates a new user claw on the current DGX-hosted multi-user NemoClaw deployment.

Required arguments:

1. Slack user ID
2. Display name
3. Claw name
4. GitHub handle

Validate before running:

- Slack user ID must match `^U[A-Z0-9]+$`
- claw name must match `^[a-z0-9][a-z0-9-]*[a-z0-9]$`
- display name and GitHub handle must be non-empty

If validation fails, stop and show:

```text
Usage: add-claw <slack_id> <display_name> <claw_name> <github_handle>
Example: add-claw U12345ABC "Jane Doe" jane-claw janedoe
```

Run from the repo root:

```bash
node bin/nemoclaw.js user-add --non-interactive \
  --slack-id "<slack_id>" \
  --display-name "<display_name>" \
  --claw-name "<claw_name>" \
  --github-user "<github_handle>"
```

Then run full bring-up:

```bash
bash scripts/nemoclaw-resilience.sh \
  --sandbox "<claw_name>" \
  --cred-dir "persist/users/<slack_id>/credentials" \
  --github-user "<github_handle>" \
  --slack-user-id "<slack_id>"
```

Notes:

- The Slack bridge now reloads user registry state per message, so no bridge restart is required after add.
- Report failures immediately and stop at the failing step.
- Summarize:
  - user registered
  - sandbox created
  - resilience run completed or failed
  - any warnings
