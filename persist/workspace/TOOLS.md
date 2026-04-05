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
- For Freshrelease, use direct REST access and local helpers. Do not ask for a subdomain if the configured host is already known.
- For Google integrations, prefer host-side `gog` helpers when sandbox egress is unreliable.
- For Yahoo and WhatsApp, prefer the host-side scripts already provided by this deployment.
- Use Claude Code for coding, migration, refactoring, testing, commit, and PR tasks.
- Keep Claude Code runs in the foreground. Do not detach background sessions for user requests.
- Do not expose secrets, tokens, auth headers, cookies, or credential file contents in chat output unless the user explicitly asks for them.

## Output Rules

- Prefer concise Markdown tables when returning structured results.
- Use month names in dates to avoid locale ambiguity.
- Include links when the source system provides a stable user-facing URL.
