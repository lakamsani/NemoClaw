# Codex Changes Review

## What was changed (10 files, ~970 lines added, ~250 removed)

### 1. Role-based access control (`user-registry.js`, `nemoclaw.js`)
- Added `roles` field to users with `normalizeRoles()` and `hydrateUser()` helpers
- New CLI commands: `user-enable`, `user-disable`, `user-grant-admin`, `user-revoke-admin`
- `--admin` flag on `user-add`

### 2. Slack admin commands (`slack-bridge-multi.js` — +685 lines)
- `!add-claw`, `!delete-claw` / `!confirm-delete-claw` — provision/destroy users via Slack DM
- `!admins`, `!admin-audit`, `!show-claws` — visibility commands
- Audit log for all admin actions (`persist/audit/admin-actions.log`)
- Auth-error auto-retry: detects `authentication_error`/`invalid_grant`, refreshes credentials, retries once
- `SLACK_ADMIN_USERS` env var for allowlist-based admin promotion
- Exported pure functions + `require.main === module` guard for testability

### 3. Credential refresh hardening (`refresh-credentials.sh`)
- Idempotent gateway restarts: compares current vs desired API key/gateway token, only restarts when changed
- OAuth refresh retries 3 times with backoff
- Removed `--bare` flag (was skipping OAuth)
- GOG_KEYRING_PASSWORD and Slack webhook now sourced per-user, not from global env
- Extracted `restart_gateway()` function

### 4. Gateway health check (`nemoclaw-resilience.sh`)
- Replaced `sleep 5` + fire-and-forget with a retry loop (up to 10 attempts, 2s apart) and a proper failure exit

### 5. Cron frequency (`setup-cron.sh`)
- Credential refresh bumped from every 30 min to every 15 min

### 6. Tests (`registry.test.js`, `slack-bridge-multi.test.js`)
- New user-registry tests for role normalization
- Comprehensive Slack bridge unit tests for parsing, admin detection, inventory formatting

---

## Critique and Suggested Improvements

### Security Issues

1. **Command injection in `handleAddClaw` / `handleDeleteClaw`** — The `sh()` function only escapes single quotes, but the values are interpolated into shell strings. A Slack user ID like `U123'; rm -rf /; echo '` would bypass the regex check only if the regex is wrong — but the regex `^U[A-Z0-9]+$` is strict enough to prevent this for `slackId`. However, `displayName` passes through `sh()` into a shell command and could contain metacharacters beyond single quotes (e.g., backticks, `$(...)`) if someone crafts a name. **Fix**: use `execFileSync` with argument arrays instead of string interpolation, or at minimum escape `$` and backticks in `sh()`.

2. **`pendingDeleteRequests` has no expiry** — A delete confirmation can be issued hours or days after the initial request. Add a TTL (e.g., 5 minutes) check in `handleConfirmDeleteClaw`.

### Reliability

3. **`restart_gateway()` in `refresh-credentials.sh` has no health check loop** — It does a single `openclaw gateway call health` after `sleep 5`. The resilience script was upgraded to a 10-attempt loop, but this function wasn't. Should be consistent.

4. **`refresh-all-credentials.sh` removed host-to-persist credential sync** — The deleted 9 lines copied `~/.claude/.credentials.json` to per-user cred dirs. Now this only happens inside `refresh-credentials.sh` after a successful OAuth refresh. If OAuth refresh is skipped (token not expiring), the per-user copy won't be updated from a manually refreshed host token.

5. **15-minute cron may be too aggressive** — Doubling the frequency without clear justification increases SSH load on sandboxes. Consider keeping 30 min unless token expiry windows require it.

### Code Quality

6. **`path` imported redundantly** — Line 19 has `const path = require("path")` and line 46 has `require("path").resolve(...)`. Not a bug, just redundant. Minor.

7. **`OPENSHELL` null check moved inside `main()`** — Good for testability, but now `OPENSHELL` is evaluated at module load (line 23). If it's null, `runAdminCommand` functions that use it before `main()` validates would get a confusing error.

8. **No input length limit on `!add-claw` display names** — A very long display name would bloat audit logs and Slack messages. Consider a 50-char cap.

9. **`buildShowClawsTablePayload` calls `buildClawInventory()` which shells out to `openshell sandbox list`** — If this hangs or takes long, Slack will see the command as unresponsive. The 30s timeout helps, but consider caching.

### Missing Features

10. **No `!help` command** listing available admin commands.

11. **The `!confirm-delete-claw` flow is per-user in-memory** — If the bridge restarts between `!delete-claw` and `!confirm-delete-claw`, the pending request is lost silently. This is acceptable but worth documenting.

---

## Summary

Overall the changes are **solid and well-structured** — the role system, admin commands, audit trail, credential refresh hardening, and testability improvements are all valuable. The main items to fix before pushing:

| Priority | Issue | File(s) |
|----------|-------|---------|
| P0 | Harden `sh()` or switch to `execFileSync` to prevent shell injection via display names | `slack-bridge-multi.js` |
| P0 | Add TTL expiry to `pendingDeleteRequests` | `slack-bridge-multi.js` |
| P1 | Add health-check retry loop to `restart_gateway()` | `refresh-credentials.sh` |
| P1 | Re-evaluate removal of host-to-persist credential sync | `refresh-all-credentials.sh` |
| P2 | Add `!help` command, input length limits, minor cleanup | `slack-bridge-multi.js` |

All 26 tests pass (registry + slack-bridge-multi).
