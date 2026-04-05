# Multi-User Runtime

The multi-user deployment now uses one shared runtime policy file:

- [`config/multi-user/runtime.json`](/home/vamsee/NemoClaw-multi-user-claude/config/multi-user/runtime.json)

It defines:

- sandbox create and readiness timeouts
- reconcile timeout
- resilience helper timeout
- default and conditional network policy presets
- shared workspace default files
- default tool-priority guidance

## Operational Rules

The current production model is:

- Freshrelease uses direct REST plus local helpers
- Google uses host-side `gog` helpers
- Yahoo and WhatsApp use host-side scripts
- Claude Code is reserved for real coding tasks
- Sandboxes should be treated as successful once they are actually `Ready`, even if a wrapper command is noisy or late to exit

## Shared Workspace Defaults

New claws inherit shared defaults from:

- [`persist/workspace/AGENTS.md`](/home/vamsee/NemoClaw-multi-user-claude/persist/workspace/AGENTS.md)
- [`persist/workspace/BOOTSTRAP.md`](/home/vamsee/NemoClaw-multi-user-claude/persist/workspace/BOOTSTRAP.md)
- [`persist/workspace/HEARTBEAT.md`](/home/vamsee/NemoClaw-multi-user-claude/persist/workspace/HEARTBEAT.md)
- [`persist/workspace/IDENTITY.md`](/home/vamsee/NemoClaw-multi-user-claude/persist/workspace/IDENTITY.md)
- [`persist/workspace/SOUL.md`](/home/vamsee/NemoClaw-multi-user-claude/persist/workspace/SOUL.md)
- [`persist/workspace/TOOLS.md`](/home/vamsee/NemoClaw-multi-user-claude/persist/workspace/TOOLS.md)
- [`persist/workspace/USER.md`](/home/vamsee/NemoClaw-multi-user-claude/persist/workspace/USER.md)

Existing claws can be resynced from those files, but `USER.md` should generally remain user-specific once customized.
