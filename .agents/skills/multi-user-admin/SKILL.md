---
name: multi-user-admin
description: Inspect the current DGX multi-user NemoClaw deployment. Use when asked to show claws, show a user, list admins, review recent admin audit entries, or explain available admin commands for the current multi-user deployment.
---

# Multi-User Admin

This skill handles non-destructive admin inspection commands for the current DGX-hosted multi-user NemoClaw deployment.

Use it for:

- `show-claws`
- `show-user`
- `admins`
- `admin-audit`
- `admin-help`

## Command mapping

### Show all claws

Run:

```bash
node bin/nemoclaw.js user-list
openshell sandbox list
```

Use the registry plus live sandbox list to summarize:

- claw name
- Slack user
- GitHub user when present
- enabled/disabled state
- live phase when present

### Show one user

Required argument:

1. Slack user ID

Run:

```bash
node bin/nemoclaw.js user-status "<slack_id>"
```

If the caller gives a claw name instead of a Slack ID, resolve it from `~/.nemoclaw/users.json` first.

### List admins

Run:

```bash
node - <<'NODE'
const reg = require('./bin/lib/user-registry');
const { users } = reg.listUsers();
for (const user of users.filter((u) => (u.roles || []).includes('admin'))) {
  console.log(`${user.slackDisplayName || user.slackUserId}\t${user.slackUserId}\t${user.sandboxName || ''}`);
}
NODE
```

### Recent admin audit

Run:

```bash
tail -n 20 persist/audit/admin-actions.log
```

If the file is missing, say there are no audit records yet.

### Admin help

Report these supported Slack admin commands:

```text
!admin-help
!admins
!admin-audit
!show-claws
!show-user <slack-id|claw-name|name-fragment>
!add-claw <slack_id> <display_name> <claw_name> <github_handle>
!purge-claw <claw_name>
!delete-claw <claw_name>
!confirm-delete-claw <claw_name>
```

## Notes

- Keep replies concise and operational.
- Prefer live state over stale assumptions.
- Do not mutate users or sandboxes from this skill.
