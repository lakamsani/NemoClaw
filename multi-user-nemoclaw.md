# Multi-User NemoClaw

## Overview

This deployment runs one claw per user inside isolated OpenShell sandboxes and exposes them primarily through Slack, with WhatsApp and host-side notification integrations where needed.

The old Claude-managed setup was unstable because too much behavior lived in drifting prompts, cron reinjection, and flaky bridge-to-agent delegation. The current Codex-managed baseline moves the system toward deterministic helpers, shared runtime config, recoverable provisioning, and explicit migration tooling.

**Current status:** Codex-managed recovery baseline is in place. Active claws were rebuilt, Slack developer experience was sanity-tested, and the main remaining validation is Slack-side admin command testing.

The last reliability fixes in this pass were:

- hardened Freshrelease helper retries and project resolution for natural-language project names such as `email` and `search`
- hardened Google `gog` helper binary resolution so daemon PATH drift does not break host-side Google queries
- documented the currently working OpenClaw admin UI access path through Kubernetes port-forward plus a second SSH hop from a laptop browser

---

## Architecture

<p align="center">
  <img src="docs/multi-user-architecture.svg" alt="Codex-managed multi-user NemoClaw architecture" width="100%" />
</p>

<details>
<summary>Text version (for terminals)</summary>

```text
Slack App / WhatsApp
    │
    ▼
Slack bridge / WhatsApp bridge  ── per-user queue ── registry lookup ── pending-run recovery
    │
    ├── Host-side deterministic helpers
    │     ├── Freshrelease REST
    │     ├── Google gog helper
    │     ├── Yahoo mail helper
    │     └── WhatsApp/notification helpers
    │
    └── OpenShell sandboxes
          ├── one sandbox per user
          ├── direct Claude Code foreground path for coding tasks
          └── shared workspace defaults + per-user credentials

Shared control files:
  ~/.nemoclaw/users.json
  ~/.nemoclaw/sandboxes.json
  config/multi-user/runtime.json
  persist/migration/live-snapshot/
```
</details>

### Design Decisions

- One Slack app handles all users.
- One user maps to one sandbox and one workspace.
- Per-user queues serialize work per claw.
- Pending Slack runs persist to disk and expire cleanly on restart.
- Deterministic host-side helpers are preferred for SaaS integrations when sandbox egress is brittle.
- Claude Code is used directly for real coding tasks and kept in the foreground.
- Shared runtime behavior comes from repo config instead of prompt drift.

---

## Runtime Policy

Shared runtime policy is defined in [config/multi-user/runtime.json](config/multi-user/runtime.json).

It controls:

- sandbox create and readiness timeouts
- reconcile timeout
- resilience helper timeout
- default and conditional network policy presets
- shared workspace default files

Implementation helpers:

- [bin/lib/runtime-config.js](bin/lib/runtime-config.js)
- [bin/lib/sandbox-lifecycle.js](bin/lib/sandbox-lifecycle.js)

### Sandbox Lifecycle

The recovery baseline no longer treats wrapper noise as authoritative. If a sandbox actually becomes `Ready`, create/bootstrap flows treat that as success even if the originating shell command is noisy or late to exit.

This is now used by:

- [bin/lib/bootstrap.js](bin/lib/bootstrap.js)
- [bin/lib/reconcile.js](bin/lib/reconcile.js)
- [bin/nemoclaw.js](bin/nemoclaw.js)

---

## Inference and Tooling Policy

### Operating policy

The Codex-managed operating policy is:

| Priority | Path | Purpose |
|----------|------|---------|
| 1 | Direct APIs | Stable SaaS integrations where simple REST works |
| 2 | Native CLIs | GitHub, git, language tools, sandbox commands |
| 3 | Local helper scripts | Deterministic wrappers for flaky or repetitive workflows |
| 4 | Skills/plugins | Structured workflows where needed |
| 5 | Claude Code | Real coding, migrations, testing, commits, PRs |

### Current practical usage

| Capability | Current path |
|------------|--------------|
| Coding / migrations / PR work | Direct Claude Code inside sandbox, foreground only |
| Freshrelease | Deterministic REST helper, no MCP |
| Google tasks / calendar | Host-side `gog` helper |
| Yahoo mail | Host-side helper |
| WhatsApp routing | Host-side bridge/helper |

### Target model policy

The desired model policy for the claw fleet remains:

- Primary claw agent model: Anthropic Sonnet
- Fallback 1: NVIDIA Nemotron Instruct
- Fallback 2: NVIDIA Llama 70B
- Claude Code: Anthropic only

That policy is documented as the intended operating model even where some live paths still rely on legacy OpenClaw runtime behavior.

---

## Messaging Channels

### Slack

[scripts/slack-bridge-multi.js](scripts/slack-bridge-multi.js) is the main user-facing bridge.

Current capabilities validated during sanity testing:

- normal claw prompts
- repo/coding tasks
- direct Claude Code tasks
- Freshrelease queries with clickable links
- Google tasks/calendar queries with clickable links
- retry handling for previous requests
- stale pending-run cleanup on restart
- unknown `!` commands fail closed instead of dumping sandbox startup noise
- `!purge-claw <name>` is supported as a one-step destructive admin command

### WhatsApp

[scripts/whatsapp-bridge-multi.js](scripts/whatsapp-bridge-multi.js) remains in place. Core routing and preserved auth state were carried forward, but WhatsApp was not the main focus of the initial sanity pass.

---

## Freshrelease Integration

Freshrelease is now intentionally kept off MCP.

### Rules

- Use direct REST only
- Do not ask for the subdomain if the configured host is already known
- Do not route Freshrelease through Claude Code or browser relay

### Current host

- `https://freshworks.freshrelease.com`

### Deterministic helper

- [scripts/freshrelease-epics.py](scripts/freshrelease-epics.py)

Current supported natural-language coverage includes:

- active epics by project
- child stories/issues under an epic
- issue details
- state filtering such as `open`
- clickable issue links

Returned fields were expanded to include:

- assigned user
- current state
- created date
- targeted date
- updated date
- description and comments for issue detail views

Recent hardening:

- transient API/network failures now retry before failing
- per-project failures return readable errors instead of Python tracebacks
- helper can resolve friendly project names through Freshrelease project discovery when exact keys are not supplied

---

## Google Integration

Google access currently uses a host-side helper rather than sandbox egress.

Helper:

- [scripts/gog-query.py](scripts/gog-query.py)

Reasons:

- more reliable than sandbox DNS/proxy paths
- per-user `gogcli` bundles already exist
- simpler to debug than in-sandbox OAuth/eager network policy work

Recent hardening:

- helper now resolves the `gog` binary explicitly instead of relying on inherited daemon PATH
- this prevents Slack bridge processes from failing when interactive shells can find `gog` but service-like processes cannot

---

## OpenClaw Admin UI Access

The direct `openshell sandbox ssh-config ...` plus `ssh -L ...` path was unreliable for Control UI HTTP/WebSocket traffic in this environment. The stable working path is:

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

- In this topology, browser device pairing was unreliable, but explicit token auth worked.
- `localhost` and `127.0.0.1` must be treated consistently because the Control UI keys stored auth state by gateway URL/origin.

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
- enabled/disabled state
- roles
- per-user credential/workspace paths

---

## Per-User State

Per-user data lives under:

```text
persist/users/<slack-user-id>/
  credentials/
  workspace/
```

Shared workspace defaults now live in repo-owned files under:

- [persist/workspace](persist/workspace)

These defaults include:

- `AGENTS.md`
- `BOOTSTRAP.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `SOUL.md`
- `TOOLS.md`
- `USER.md`

These are copied into new claws and can be resynced into existing claws. `USER.md` should generally remain user-specific once customized.

---

## Migration Tooling

Codex-managed rebuild and recovery now uses explicit local tooling instead of shell history.

### Commands

```text
nemoclaw migration-export [--output DIR]
nemoclaw migration-import --input DIR [--force]
nemoclaw migration-inspect --input DIR
nemoclaw migration-restore-user --input DIR --slack-id ID [--force]
nemoclaw migration-restore-all --input DIR [--force] [--include-disabled]
nemoclaw bootstrap-user <id> [--dry-run]
nemoclaw bootstrap-all [--dry-run] [--include-disabled]
nemoclaw reconcile-user <id> [--dry-run]
nemoclaw reconcile-all [--dry-run] [--include-disabled]
```

---

## Commit and Push Guidance

This migration produced two distinct classes of change:

### Commit-worthy repo changes

- bridge behavior
- deterministic helper scripts
- migration/bootstrap/reconcile/runtime code
- tests
- docs
- shared workspace defaults
- skills under `.agents/skills/`

### Do not push live machine state or secrets

- `persist/users/**/credentials/**`
- `persist/gateway/**`
- `persist/pending-slack-runs.json`
- `persist/migration/live-snapshot/**`
- `persist/audit/**`
- `nohup.out`
- ad hoc local scratch directories such as `.entire/` or `.remember/`

Before pushing, the worktree should be split so product code/docs are committed, while live deployment state stays local or is moved into explicitly redacted example fixtures.

Main implementation files:

- [bin/lib/migration.js](bin/lib/migration.js)
- [bin/lib/bootstrap.js](bin/lib/bootstrap.js)
- [bin/lib/reconcile.js](bin/lib/reconcile.js)

Live snapshot:

- [live-snapshot](persist/migration/live-snapshot)

---

## Automation

### Still active

- bridge supervision / watchdog
- Yahoo periodic summary checks
- WhatsApp/Slack notification forwarding where configured

### No longer the desired steady-state model

- blind periodic credential reinjection as the main correctness mechanism
- browser/MCP fallback for Freshrelease
- background Claude Code delegation that reports success before work is finished

The system is now moving toward:

- reconcile-on-change
- deterministic helpers
- explicit migration/restore flows
- config-driven runtime behavior

---

## Security and Reliability

### Preserved

- per-user credential isolation
- RBAC for admin commands
- network policy enforcement per sandbox
- audit logging

### Improved during Codex-managed recovery

- stale pending-run cleanup
- retry safety
- output redaction for leaked secrets in Slack responses
- recoverable `user-add` path
- wrapper hardening around late/noisy sandbox create behavior

---

## Migration Status

| Step | Status |
|------|--------|
| Freeze and export current state | Completed |
| Define shared runtime/config model | Completed |
| Build deterministic rebuild tooling | Completed |
| Rebuild active claws | Completed |
| Restore Vamsee-specific integrations | Completed |
| Stabilize Slack developer experience | Completed |
| Normalize shared claw instructions | Completed |
| Fix official CLI/operator path | Completed |
| Make provisioning recoverable | Completed |
| Clean stale runtime state | Completed |
| Harden wrapper/runtime issues | Completed |
| Validate Slack-side admin flows | Pending |
| Final ops cutover from Claude-managed to Codex-managed | In progress, functionally complete except admin Slack validation |

---

## Key Files

| File | Purpose |
|------|---------|
| [bin/nemoclaw.js](bin/nemoclaw.js) | CLI entry point and user lifecycle commands |
| [bin/lib/runtime-config.js](bin/lib/runtime-config.js) | Shared multi-user runtime config loader |
| [bin/lib/sandbox-lifecycle.js](bin/lib/sandbox-lifecycle.js) | Health-first sandbox create/readiness helpers |
| [bin/lib/migration.js](bin/lib/migration.js) | Export/import/inspect/restore tooling |
| [bin/lib/bootstrap.js](bin/lib/bootstrap.js) | Sandbox bootstrap/adopt flow |
| [bin/lib/reconcile.js](bin/lib/reconcile.js) | Credential reconcile flow |
| [scripts/slack-bridge-multi.js](scripts/slack-bridge-multi.js) | Main multi-user Slack bridge |
| [scripts/freshrelease-epics.py](scripts/freshrelease-epics.py) | Deterministic Freshrelease helper |
| [scripts/gog-query.py](scripts/gog-query.py) | Host-side Google helper |
| [scripts/inject-user-credentials.sh](scripts/inject-user-credentials.sh) | Per-user credential injection |
| [scripts/nemoclaw-resilience.sh](scripts/nemoclaw-resilience.sh) | Full bring-up / recovery script |
| [docs/reference/multi-user-runtime.md](docs/reference/multi-user-runtime.md) | Runtime policy reference |
