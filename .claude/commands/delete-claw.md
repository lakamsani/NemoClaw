---
description: Completely delete a NemoClaw user — destroys sandbox, removes registry entry, deletes all persist data
argument-hint: <claw_name>
---

## Delete a NemoClaw claw (full purge)

One argument is required (from $ARGUMENTS):

1. **Claw/sandbox name** (e.g. alice-claw)

### Step 1: Validate

The claw name is required. If missing, stop and show:
```
Usage: /delete-claw <claw_name>
Example: /delete-claw alice-claw
```

Verify:
- claw_name is lowercase letters, numbers, and hyphens
- The claw exists: run `node bin/nemoclaw.js user-list` and confirm the sandbox name appears
- If the claw is NOT found in the user list, tell the user and stop

### Step 2: Confirm with the user

Before proceeding, show what will be destroyed:
- The sandbox container (openshell)
- The user registry entry (users.json)
- All persist data (credentials, workspace files)

**Ask the user to confirm** before proceeding. This is destructive and irreversible.

### Step 3: Purge user and sandbox

Run from the repo root (`/home/vamsee/NemoClaw-multi-user-claude`):

```bash
node bin/nemoclaw.js user-purge --sandbox "<claw_name>"
```

Show the output to the user. If it fails, report the error and stop.

### Step 4: Restart the Slack bridge

The Slack bridge caches the user registry at startup. Restart it so it stops routing messages for the deleted user:

```bash
bash scripts/start-services.sh restart
```

Verify the bridge is running after restart.

### Step 5: Report results

Summarize:
- User deregistered
- Sandbox destroyed
- Persist data deleted
- Slack bridge restarted

If any step had warnings, report them.
