---
name: purge-claw
description: Fully purge a NemoClaw user from the current DGX multi-user deployment in one step. Use when asked to purge a claw, fully remove a claw immediately, destroy a user sandbox and all persist data, or skip the staged delete-confirm flow and do the destructive purge directly.
---

# Purge Claw

This skill performs the destructive one-step purge path for a claw on the current DGX-hosted multi-user NemoClaw deployment.

Required argument:

1. Claw name

Validate before running:

- claw name must match `^[a-z0-9][a-z0-9-]*[a-z0-9]$`
- the claw should exist in the registry or live sandbox list

If validation fails, stop and show:

```text
Usage: purge-claw <claw_name>
Example: purge-claw alice-claw
```

Before destruction, confirm with the user that this removes:

- the sandbox
- the user registry entry
- all persist data for that user

Run from the repo root:

```bash
node bin/nemoclaw.js user-purge --sandbox "<claw_name>"
```

Summarize:

- sandbox destroyed or already absent
- registry entry removed or already absent
- persist data removed
- any warnings

Notes:

- This is destructive.
- Unlike `delete-claw`, this skill does not stage a separate confirmation step internally.
