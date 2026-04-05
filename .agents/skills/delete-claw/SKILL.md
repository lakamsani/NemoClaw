---
name: delete-claw
description: Fully purge a NemoClaw user from the current DGX multi-user deployment by deleting their sandbox, registry entry, and persist data. Use when asked to delete a claw, remove a claw, purge a user sandbox, or deprovision a Slack user from the current deployment.
---

# Delete Claw

This skill performs a full purge for a claw on the current DGX-hosted multi-user NemoClaw deployment.

Required argument:

1. Claw name

Validate before running:

- claw name must match `^[a-z0-9][a-z0-9-]*[a-z0-9]$`
- the claw must exist in `node bin/nemoclaw.js user-list`

If validation fails, stop and show:

```text
Usage: delete-claw <claw_name>
Example: delete-claw alice-claw
```

Before destruction, confirm with the user that this will remove:

- the sandbox
- the user registry entry
- all persist data for that user

Run from the repo root:

```bash
node bin/nemoclaw.js user-purge --sandbox "<claw_name>"
```

Notes:

- The Slack bridge now reloads user registry state per message, so no bridge restart is required after delete.
- This is destructive. Do not continue without explicit confirmation.
- Summarize:
  - sandbox destroyed
  - registry entry removed
  - persist data removed
  - any warnings
