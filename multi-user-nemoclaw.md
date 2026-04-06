# Multi-User NemoClaw

## Overview

This deployment runs one claw per user inside isolated OpenShell sandboxes and exposes them primarily through Slack, with WhatsApp and host-side mail helpers where sandbox egress is not a good fit.

The current baseline is Anthropic-managed. The bridge owns Slack routing, admin commands, self-service credential setup, per-user queueing, pending-run recovery, and response filtering. The sandbox fleet owns user workspace state, in-sandbox tools such as `gog` and Freshrelease MCP, and foreground coding work through the default OpenClaw `main` agent.

**Current status:** the active shape of the system is a DM-only Slack bridge with direct admin commands, shared runtime policy in repo config, per-user credential injection, recoverable add/delete flows, and a simplified Slack execution path that launches the sandbox `main` agent directly.

---

## Architecture

<p align="center">
  <img src="docs/multi-user-architecture-codex.svg" alt="Codex-managed multi-user NemoClaw architecture" width="100%" />
</p>

<details>
<summary>Text version (for terminals)</summary>

```text
Slack App / WhatsApp
    │
    ▼
Slack bridge / WhatsApp bridge  ── per-user queue ── pending-run recovery ── admin audit
    │
    ├── Host-side control plane
    │     ├── self-service !setup credential handling
    │     ├── add/delete/purge/show admin commands
    │     ├── Yahoo / email-query helpers
    │     ├── WhatsApp bridge helpers
    │     └── rate-limit cooldown + inference fallback routing
    │
    └── OpenShell sandboxes
          ├── one sandbox per user
          ├── shared workspace defaults + per-user credentials
          ├── in-sandbox Freshrelease MCP and Google gog access
          └── foreground coding work through the sandbox main agent

Shared control files:
  ~/.nemoclaw/users.json
  ~/.nemoclaw/sandboxes.json
  config/multi-user/runtime.json
  persist/audit/admin-actions.log
  persist/users/<slack-user-id>/
```
</details>

### Design Decisions

- One Slack app handles all users.
- The bridge only responds in 1:1 Slack DMs.
- One user maps to one sandbox and one workspace.
- Per-user queues serialize work per claw.
- Pending Slack runs persist to disk and expire cleanly on restart.
- Admin commands are handled directly on the host, not by the sandbox agent.
- Shared runtime behavior comes from repo config instead of prompt drift.
- Coding work stays in the foreground through the sandbox `main` agent.

---

## Runtime Policy

Shared runtime policy is defined in [config/multi-user/runtime.json](config/multi-user/runtime.json).

It controls:

- sandbox create, readiness, and post-create recovery timeouts
- reconcile and resilience helper timeouts
- default network policy presets: `npm`, `pypi`, and `slack`
- conditional policy presets for Google and Freshrelease credentials
- shared workspace default files
- default tool-priority guidance

Implementation helpers:

- [bin/lib/runtime-config.js](bin/lib/runtime-config.js)
- [bin/lib/sandbox-lifecycle.js](bin/lib/sandbox-lifecycle.js)
- [bin/lib/bootstrap.js](bin/lib/bootstrap.js)
- [bin/lib/reconcile.js](bin/lib/reconcile.js)

### Sandbox Lifecycle

Create and bootstrap flows now treat actual sandbox health as authoritative. If a sandbox reaches `Ready`, lifecycle helpers treat that as success even when the wrapper command is noisy or exits late.

This behavior is used by:

- [bin/lib/bootstrap.js](bin/lib/bootstrap.js)
- [bin/lib/reconcile.js](bin/lib/reconcile.js)
- [bin/nemoclaw.js](bin/nemoclaw.js)

---

## Inference and Tooling Policy

### Operating Policy

The shared tool order is:

| Priority | Path | Purpose |
|----------|------|---------|
| 1 | Direct APIs | Stable SaaS integrations where simple REST works |
| 2 | Native CLIs | GitHub, git, language tools, sandbox commands |
| 3 | Local helper scripts | Deterministic wrappers for repetitive or brittle host flows |
| 4 | Skills or plugins | Structured workflows where needed |
| 5 | OpenClaw main agent | Coding, migrations, testing, commits, PRs |

### Current Practical Usage

| Capability | Current path |
|------------|--------------|
| Coding and repo work | Direct OpenClaw `main` agent inside the sandbox, foreground only |
| Freshrelease | In-sandbox Freshrelease MCP via `mcporter` |
| Google tasks and calendar | In-sandbox `gog` |
| Yahoo mail and email triage | Host-side `email-query.py` and `yahoo-mail.py` |
| WhatsApp routing | Host-side bridge/helper |
| Admin operations | Host-side Slack bridge commands plus audit log |

### Inference Routing

The steady-state preference is Anthropic for normal Slack runs through the sandbox `main` agent, with bridge-owned fallback routing available when that path is unavailable.

Current behavior:

- if Anthropic auth fails or the provider is rate-limited, the bridge pauses new launches briefly with a global cooldown
- the bridge can switch the sandbox to NVIDIA NIM fallback using the first configured NVIDIA model
- if that fails, it can try local Ollama fallback models in order: `deepseek-r1:70b`, `qwen3-coder:30b`, `gpt-oss:latest`
- after a fallback run, the bridge restores the sandbox primary model
- selection metadata is synced into the sandbox so the user-visible runtime stays aligned with the active provider route

Per-user Claude setup resets the sandbox primary model back to Anthropic for normal runs.

---

## Slack Bridge

[scripts/slack-bridge-multi.js](scripts/slack-bridge-multi.js) is the main user-facing bridge.

Current bridge behavior includes:

- DM-only routing for user requests
- per-user queueing to avoid OpenClaw session lock conflicts
- persisted pending-run recovery with stale-run cleanup on restart
- direct admin command handling with audit logging
- self-service `!setup` credential and workspace customization flows
- direct `!yahoo` and `!wa` host-side commands
- natural-language Yahoo email queries routed through `email-query.py`
- retry handling for the user's previous request
- fail-closed handling for unknown `!` commands

### Admin Commands

Admin commands are handled directly by the bridge and do not go through the sandbox agent.

The current operator surface is:

- `!admin-help`
- `!admins`
- `!admin-audit`
- `!show-claws [ready|not-ready|registered|unregistered|admins|non-admins|gpu] [sort=name|user|status|uptime] [match=...] [policy=...] [cred=...]`
- `!show-user <slack-id|claw-name|name-fragment>`
- `!add-claw <slack_id> <display_name> <claw_name> <github_handle>`
- `!delete-claw <claw_name>`
- `!confirm-delete-claw <claw_name>`
- `!purge-claw <claw_name>`

Delete confirmations expire after five minutes and are lost if the bridge restarts.

### Self-Service Setup

Users can configure most personal state from Slack DM with `!setup`.

The current setup surface includes:

- Claude OAuth JSON or long-lived Claude token
- GitHub token
- Google `gogcli` credential archive
- Freshrelease API key
- WhatsApp number and optional webhook
- timezone
- `SOUL.md`, `IDENTITY.md`, `USER.md`, and `HEARTBEAT.md` content
- `!setup status` and `!setup help`

Credential-bearing `!setup` commands are DM-only. The bridge attempts to delete the original Slack credential message after processing.

---

## Messaging Channels

### Slack

Slack is the main operator and user interface.

Validated or implemented capabilities in the current bridge include:

- normal claw prompts
- coding and repo tasks through the foreground sandbox `main` agent
- Freshrelease and Google requests through in-sandbox tools
- natural-language Yahoo inbox and search queries
- direct `!yahoo` mail actions
- direct `!wa` and `!whatsapp` host-side actions
- retry of the previous user request
- stale pending-run cleanup on restart
- admin inventory and destructive lifecycle commands

### WhatsApp

[scripts/whatsapp-bridge-multi.js](scripts/whatsapp-bridge-multi.js) remains in place for per-user messaging and notification forwarding. The Slack bridge can also forward notification-like messages to a user's configured WhatsApp number.

---

## Freshrelease Integration

Freshrelease now follows the shared tool policy in [persist/workspace/TOOLS.md](persist/workspace/TOOLS.md).

Current rules:

- use the in-sandbox Freshrelease MCP server via `mcporter`
- keep the user's Freshrelease API key in their per-user credential directory
- allow the `freshworks` policy preset when the user has Freshrelease credentials
- do not route normal Freshrelease work through host-side helper scripts
- use Claude Code only when the task is actually coding work, not for routine Freshrelease queries

---

## Google Integration

Google access runs inside the sandbox via `gog`.

Current rules:

- inject the user's `gogcli` credentials into the sandbox with `!setup google`
- allow the `google` policy preset when the user has Google credentials
- use Google Tasks and Google Calendar from inside the claw
- keep reminder-like requests on Google Tasks by default unless the user explicitly wants a calendar event

Yahoo remains host-side because the deployed path still depends on direct mail access outside the sandbox proxy flow.

---

## Email Handling

Yahoo mail is handled on the host.

Current paths:

- explicit mail commands go through `!yahoo`
- natural-language inbox or search requests are parsed by the Slack bridge and routed through [scripts/email-query.py](scripts/email-query.py)
- mail results are normalized into concise Markdown tables before they are returned to Slack

The bridge also remembers the last Yahoo-style request so a follow-up such as a year refinement can reuse the same search intent.

---

## OpenClaw Admin UI Access

The direct `openshell sandbox ssh-config ...` plus `ssh -L ...` path was unreliable for Control UI HTTP and WebSocket traffic in this environment. The stable working path is:

1. On the Linux host, run a Kubernetes port-forward from the OpenShell sidecar container:

```bash
docker exec -i openshell-cluster-nemoclaw \
  kubectl port-forward --address 0.0.0.0 -n openshell pod/<sandbox-name> 18889:18789
```

2. From a laptop, forward that host port locally:

```bash
ssh -N -L 18889:172.18.0.2:18889 <linux-user>@<linux-host>
```

3. Open the browser at:

```text
http://localhost:18889/
```

Token bootstrap URL for initial setup:

```text
http://localhost:18889/#token=<gateway-token>
```

Notes:

- browser device pairing was unreliable in this topology, but explicit token auth worked
- `localhost` and `127.0.0.1` must be treated consistently because the Control UI stores auth state by gateway URL and origin

---

## User Registry

Primary registry files:

- `~/.nemoclaw/users.json`
- `~/.nemoclaw/sandboxes.json`

The current system preserves:

- Slack user ID
- display name
- sandbox name
- GitHub user
- enabled or disabled state
- timezone
- roles
- per-user credential and workspace paths

Admin actions are also appended to:

- `persist/audit/admin-actions.log`

---

## Per-User State

Per-user data lives under:

```text
persist/users/<slack-user-id>/
  credentials/
  workspace/
```

Shared workspace defaults live in repo-owned files under:

- [persist/workspace](persist/workspace)

These defaults include:

- `AGENTS.md`
- `BOOTSTRAP.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `SOUL.md`
- `TOOLS.md`
- `USER.md`

These files are copied into new claws and can be resynced into existing claws. `USER.md` should generally remain user-specific once customized.
