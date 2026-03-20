# Multi-User NemoClaw Architecture Plan

## Overview

Run multiple assistants, each dedicated to one user, all chatting via a single Slack bot. The gateway routes to different sandboxes based on Slack user ID.

## Architecture

```
Slack App (1 bot, 1 Socket Mode connection)
    │
    ▼
slack-bridge-multi.js  ◄── user-registry.json (slackUserId → sandboxName)
    │
    ├── user U09R681EPQ9 → SSH → veyonce-claw (sandbox pod)
    ├── user U12345ABCDE → SSH → alice-claw   (sandbox pod)
    └── user U67890FGHIJ → SSH → bob-claw     (sandbox pod)
```

### Key Decision: One Slack Bot, Central Router

- One Slack app with Socket Mode handles all users
- The bridge routes messages to the correct sandbox based on Slack user ID
- No per-user Slack bot tokens needed
- Current SSH-per-sandbox design (`openshell sandbox ssh-config <name>`) already supports multi-sandbox

---

## Phase 1: User Registry + Credential Isolation

### User Registry (`~/.nemoclaw/users.json`)

```json
{
  "users": {
    "U09R681EPQ9": {
      "slackUserId": "U09R681EPQ9",
      "slackDisplayName": "vamsee",
      "sandboxName": "veyonce-claw",
      "githubUser": "lakamsani",
      "createdAt": "2026-03-20T00:00:00Z",
      "personalityDir": "persist/users/U09R681EPQ9/workspace",
      "credentialsDir": "persist/users/U09R681EPQ9/credentials",
      "enabled": true
    }
  },
  "defaultUser": "U09R681EPQ9"
}
```

- New module `bin/lib/user-registry.js` (modeled on existing `bin/lib/registry.js`): `load()`, `save()`, `getUser()`, `registerUser()`, `removeUser()`, `listUsers()`

### Per-User Credential Storage

```
persist/users/<slack-user-id>/
  .env                          # User-specific env vars
  credentials/
    claude-credentials.json     # Claude OAuth token
    gh-hosts.yml                # GitHub token
    gogcli/                     # Google OAuth tokens (config.json, credentials.json, keyring/, tokens/)
    twitter-creds.txt           # X/Twitter tokens (optional)
  workspace/
    SOUL.md                     # Personality customization
    IDENTITY.md
    USER.md
    TOOLS.md
    HEARTBEAT.md
```

### Parameterized Credential Injection

- Refactor `scripts/inject-credentials.sh` → `scripts/inject-user-credentials.sh <sandbox-name> <user-credentials-dir>`
- Every `$HOME/.claude/...` becomes `$CRED_DIR/...`
- Migrate existing veyonce-claw user data into the new structure

---

## Phase 2: Multi-User Slack Bridge

### Changes to `scripts/slack-bridge.js` → `scripts/slack-bridge-multi.js`

1. **Remove** global `SANDBOX` constant. Replace with per-message lookup.
2. **Load** user registry at startup. In-memory map of `slackUserId → sandboxName`.
3. **In `handleMessage`**: look up `event.user` in user map. If not found, reply with onboarding message.
4. **Pass** resolved `sandboxName` to `runAgentInSandbox`.
5. **Remove** `ALLOWED_USERS` filtering — the user registry itself becomes access control.

Session IDs already include channel + timestamp, so no collision across users. SSH config files are per-session, no conflicts.

---

## Phase 3: User Lifecycle CLI

Add commands to `bin/nemoclaw.js`:

- **`nemoclaw user-add`** — Interactive wizard:
  - Collects: Slack user ID, GitHub token, Gmail/gog OAuth, Slack webhook, personality preferences
  - Creates sandbox pod via `openshell sandbox create <name>`
  - Applies merged network policy (reuses `merge-policy.py`)
  - Injects credentials
  - Copies default or custom personality files
  - Registers in both `sandboxes.json` and `users.json`

- **`nemoclaw user-remove <slack-user-id>`** — Tears down sandbox, removes from registries
- **`nemoclaw user-list`** — Lists all registered users and sandbox status
- **`nemoclaw user-status <slack-user-id>`** — Shows sandbox health

---

## Phase 4: Multi-User Resilience

- **`nemoclaw-resilience.sh --all`**: Loop over all users in registry, run full bring-up for each sandbox
- **Single cron job**: `refresh-all-credentials.sh` iterates registry, refreshes each user's credentials
- **`start-services.sh`**: Launch multi-user bridge (one process, not N)
- **`setup-cron.sh`**: Single credential refresh cron + single workspace backup cron, both iterate over all users

---

## Phase 5: Self-Service Onboarding (Optional, Later)

- Slack slash command `/nemoclaw-register` triggers onboard flow
- User provides credentials via secure DM or web form
- Requires Slack command handler in the bridge

---

## What Each New User Supplies

| Credential | Required | How Injected |
|---|---|---|
| Slack user ID | Yes | Routing key in registry |
| Slack webhook URL | Yes | → `/sandbox/.env` |
| GitHub token | Optional | → `/sandbox/.config/gh/hosts.yml` |
| Gmail/gog OAuth | Optional | → `/sandbox/.config/gogcli/` |
| Claude OAuth / API key | Yes (shared or per-user) | → `/sandbox/.claude/.credentials.json` |
| GOG_KEYRING_PASSWORD | Yes (if using gog) | → `/sandbox/.env` |

---

## Capacity (DGX Spark)

- ~512MB RAM per idle sandbox, ~2GB active
- 128GB RAM → comfortably handles 50 sandboxes
- Slack bridge: single lightweight Node.js process regardless of user count
- No per-user Slack bot tokens needed

---

## Risks and Mitigations

- **Credential isolation**: Each user's `persist/users/<id>/credentials/` is mode 700. SSH into sandbox means host credentials never cross user boundaries.
- **Slack rate limits**: Per-workspace, not per-bot. With 50 users, add a simple queue with 1-second delays between messages.
- **Session ID collisions**: Already unique (channel + timestamp). No change needed.

---

## Critical Files for Implementation

| File | Role |
|---|---|
| `scripts/slack-bridge.js` | Fork into multi-user variant |
| `bin/lib/registry.js` | Pattern for new `user-registry.js` |
| `scripts/nemoclaw-resilience.sh` | Parameterize per-user, add `--all` |
| `scripts/inject-credentials.sh` | Refactor into parameterized version |
| `bin/nemoclaw.js` | Add `user-add`, `user-remove`, `user-list` commands |
