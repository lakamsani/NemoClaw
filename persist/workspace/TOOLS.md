# TOOLS.md

Use the simplest reliable tool path first.

## Priority Order

1. Direct APIs
2. Native CLIs
3. Local helper scripts
4. Skills or plugins
5. Claude Code for real coding tasks

Avoid using browser automation or MCP when a direct API, CLI, or local helper already solves the task reliably.

## Tool Rules

- For GitHub repo work, use `gh` to resolve repositories before saying a repo is missing.
- If a repo name is present in the prompt, first try the configured GitHub user with that repo name.
- For Freshrelease, use `mcporter` with the in-sandbox Freshrelease MCP server. Do not use Claude Code or raw curl for normal Freshrelease work.
- Prefer `mcporter list freshrelease --schema` to inspect available tools, then `mcporter call freshrelease.<tool> ...` for execution.
- For Google integrations, use `gog` inside the sandbox. If Google APIs fail, fix sandbox policy/auth instead of falling back to host-side helpers.
- For reminder-like requests, default to Google Tasks via `gog`, not the `cron` tool.
- Use the user's personal Google task list by default for reminders and tasks unless the user explicitly names another list such as `Freshworks tasks`.
- If the user explicitly asks for a calendar event or a time-blocked meeting, use Google Calendar. Otherwise prefer Google Tasks, even when the request mentions a day like `Monday morning`.
- Only use `cron` for internal automation or when the user explicitly asks for an in-claw scheduled reminder instead of a Google task or calendar item.
- For Yahoo and WhatsApp, prefer the host-side scripts already provided by this deployment.
- Use Claude Code for coding, migration, refactoring, testing, commit, and PR tasks.
- Keep Claude Code runs in the foreground. Do not detach background sessions for user requests.
- Do not expose secrets, tokens, auth headers, cookies, or credential file contents in chat output unless the user explicitly asks for them.

## Output Rules

- Prefer concise Markdown tables when returning structured results.
- Use month names in dates to avoid locale ambiguity.
- Include links when the source system provides a stable user-facing URL.
