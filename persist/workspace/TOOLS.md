# TOOLS.md - Local Setup Notes

## Google Workspace (gog CLI)

- **Account:** YOUR_EMAIL
- **Services:** Gmail, Calendar, Drive, Contacts, Docs, Sheets
- **Binary:** /sandbox/.local/bin/gog
- **Keyring:** file-based, password in GOG_KEYRING_PASSWORD env var
- **Auth:** OAuth2 with refresh token (auto-refreshes)

## GitHub (gh CLI)

- **Account:** YOUR_GITHUB_USER
- **Binary:** /usr/local/bin/gh
- **Protocol:** HTTPS

## X/Twitter (xurl CLI)

- **Binary:** /sandbox/.local/bin/xurl
- **App:** nemoclaw (default app)
- **Auth:** OAuth1 (user context) + Bearer token (app context)
- **Note:** API credits may be limited on free tier. Bearer works for search, OAuth1 for posting.

## Claude Code

- **Binary:** /usr/local/bin/claude
- **Usage:** claude --permission-mode bypassPermissions --print 'task'
- **For background:** add background:true to bash tool call
- **Never use:** --dangerously-skip-permissions with PTY

## Environment

- **Platform:** DGX Spark, aarch64, Debian 12
- **Headless:** No browser, no display
- **PATH includes:** /sandbox/.local/bin (gog, xurl)
