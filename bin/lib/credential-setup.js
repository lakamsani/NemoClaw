// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Self-service credential and personality setup via Slack DM.
// Handles !setup commands: saves credentials to persist dir, injects into sandbox.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { resolveOpenshell } = require("./resolve-openshell");
const userRegistry = require("./user-registry");

const OPENSHELL = resolveOpenshell();
const REPO_DIR = path.resolve(__dirname, "../..");

function resolvePath(relPath) {
  if (relPath.startsWith("/")) return relPath;
  return path.join(REPO_DIR, relPath);
}

function sshCmd(sandbox, cmd) {
  const confPath = `/tmp/ssh-config-${sandbox}`;
  // Ensure we have a fresh SSH config
  try {
    const cfg = execSync(`"${OPENSHELL}" sandbox ssh-config "${sandbox}"`, { encoding: "utf-8" });
    fs.writeFileSync(confPath, cfg);
  } catch {
    throw new Error(`Cannot reach sandbox '${sandbox}'. Is it running?`);
  }
  return execSync(
    `ssh -F "${confPath}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "openshell-${sandbox}" ${JSON.stringify(cmd)}`,
    { encoding: "utf-8", timeout: 30000 }
  );
}

function sshPipe(sandbox, data, remoteCmd) {
  const confPath = `/tmp/ssh-config-${sandbox}`;
  const { execFileSync } = require("child_process");
  try {
    const cfg = execSync(`"${OPENSHELL}" sandbox ssh-config "${sandbox}"`, { encoding: "utf-8" });
    fs.writeFileSync(confPath, cfg);
  } catch {
    throw new Error(`Cannot reach sandbox '${sandbox}'.`);
  }
  execFileSync("ssh", ["-F", confPath, "-o", "StrictHostKeyChecking=no", `openshell-${sandbox}`, remoteCmd], {
    input: data,
    timeout: 30000,
  });
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Try to set up heartbeat cron for a user if they have a HEARTBEAT.md.
 * Non-fatal — silently skips if prerequisites aren't met.
 */
function trySetupHeartbeatCron(user) {
  try {
    const scriptPath = path.join(REPO_DIR, "scripts", "setup-heartbeat-cron.sh");
    if (!fs.existsSync(scriptPath)) return null;
    const result = execSync(
      `bash "${scriptPath}" "${user.sandboxName}" --slack-user-id "${user.slackUserId}"`,
      { encoding: "utf-8", timeout: 60000, env: { ...process.env, SSH_CONF: `/tmp/ssh-config-${user.sandboxName}` } }
    );
    if (result.includes("created")) {
      return "\nHeartbeat cron job auto-configured (every 30m).";
    }
  } catch {}
  return null;
}

// ── Setup handlers ──────────────────────────────────────────────

function setupGithub(user, token) {
  token = token.trim();
  if (!token.startsWith("ghp_") && !token.startsWith("gho_") && !token.startsWith("github_pat_")) {
    return "Invalid GitHub token. Expected a token starting with `ghp_`, `gho_`, or `github_pat_`.";
  }

  const credDir = resolvePath(user.credentialsDir);
  fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });

  // Save gh-hosts.yml
  const ghUser = user.githubUser || "user";
  const hostsYml = `github.com:\n  oauth_token: ${token}\n  user: ${ghUser}\n  git_protocol: https\n`;
  const hostsPath = path.join(credDir, "gh-hosts.yml");
  fs.writeFileSync(hostsPath, hostsYml, { mode: 0o600 });

  // Inject into sandbox
  const b64 = Buffer.from(hostsYml).toString("base64");
  sshPipe(user.sandboxName, b64 + "\n",
    "mkdir -p /sandbox/.config/gh && base64 -d | tee /sandbox/.config/gh/hosts.yml > /dev/null && chmod 600 /sandbox/.config/gh/hosts.yml");

  // Set git config
  if (user.githubUser) {
    sshCmd(user.sandboxName,
      `git config --global user.name '${user.githubUser}' && git config --global user.email '${user.githubUser}@users.noreply.github.com'`);
  }

  return `GitHub token saved and injected into sandbox \`${user.sandboxName}\`.` +
    (user.githubUser ? `\nGit config set to \`${user.githubUser}\`.` : "");
}

function setupClaude(user, jsonStr) {
  jsonStr = jsonStr.trim();
  // Accept either raw JSON or a code block
  jsonStr = jsonStr.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "");

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return "Invalid JSON. Paste the contents of your `~/.claude/.credentials.json` file.";
  }

  const credDir = resolvePath(user.credentialsDir);
  fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });

  const credPath = path.join(credDir, "claude-credentials.json");
  fs.writeFileSync(credPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });

  // Inject into sandbox
  const b64 = Buffer.from(JSON.stringify(parsed)).toString("base64");
  sshCmd(user.sandboxName, "mkdir -p /sandbox/.claude");
  sshPipe(user.sandboxName, b64 + "\n",
    "base64 -d > /sandbox/.claude/.credentials.json && chmod 600 /sandbox/.claude/.credentials.json");

  // Patch ANTHROPIC_API_KEY in openclaw config
  const accessToken = (parsed.claudeAiOauth || {}).accessToken || "";
  if (accessToken) {
    try {
      sshCmd(user.sandboxName,
        `grep -q ANTHROPIC_API_KEY /sandbox/.env 2>/dev/null && sed -i 's|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${accessToken}|' /sandbox/.env || echo 'ANTHROPIC_API_KEY=${accessToken}' >> /sandbox/.env; chmod 600 /sandbox/.env`);
    } catch {}
    try {
      const patchScript = `
import json, os
path = os.path.expanduser('~/.openclaw/openclaw.json')
if os.path.exists(path):
    cfg = json.load(open(path))
    p = cfg.get('models',{}).get('providers',{}).get('anthropic',{})
    if p:
        p['apiKey'] = '${accessToken}'
    cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = 'anthropic/claude-sonnet-4-6'
    json.dump(cfg, open(path, 'w'), indent=2)
    os.chmod(path, 0o600)
`;
      const scriptB64 = Buffer.from(patchScript).toString("base64");
      sshPipe(user.sandboxName, scriptB64 + "\n", "base64 -d | python3");
    } catch {}
  }

  return `Claude credentials saved and injected into sandbox \`${user.sandboxName}\`.\n` +
    "Anthropic runtime config was updated from the new Claude OAuth access token and reset to the Claude primary model.";
}

function setupClaudeToken(user, token) {
  token = token.trim();
  token = token.replace(/^```\s*/m, "").replace(/\s*```$/m, "").trim();

  if (!token.startsWith("sk-ant-oat")) {
    return "Invalid Claude token. Expected the long-lived token produced by `claude setup-token`.\n" +
      "It should start with `sk-ant-oat`.";
  }

  const credDir = resolvePath(user.credentialsDir);
  fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(credDir, "claude-oauth-token.txt"), token, { mode: 0o600 });

  try {
    sshCmd(user.sandboxName,
      `grep -q CLAUDE_CODE_OAUTH_TOKEN /sandbox/.env 2>/dev/null && sed -i 's|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=${token}|' /sandbox/.env || echo 'CLAUDE_CODE_OAUTH_TOKEN=${token}' >> /sandbox/.env; chmod 600 /sandbox/.env`);
    sshCmd(user.sandboxName,
      `grep -q ANTHROPIC_API_KEY /sandbox/.env 2>/dev/null && sed -i 's|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${token}|' /sandbox/.env || echo 'ANTHROPIC_API_KEY=${token}' >> /sandbox/.env; chmod 600 /sandbox/.env`);
  } catch {}

  try {
    const patchScript = `
import json, os
path = os.path.expanduser('~/.openclaw/openclaw.json')
if os.path.exists(path):
    cfg = json.load(open(path))
    p = cfg.get('models',{}).get('providers',{}).get('anthropic',{})
    if p:
        p['apiKey'] = '${token}'
    cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = 'anthropic/claude-sonnet-4-6'
    json.dump(cfg, open(path, 'w'), indent=2)
    os.chmod(path, 0o600)
`;
    const scriptB64 = Buffer.from(patchScript).toString("base64");
    sshPipe(user.sandboxName, scriptB64 + "\n", "base64 -d | python3");
  } catch {}

  return `Claude long-lived token saved and injected into sandbox \`${user.sandboxName}\`.\n` +
    "This token came from `claude setup-token`, is now the preferred per-user Claude auth source, and reset the sandbox back to the Claude primary model.";
}

function setupGoogle(user, b64Data) {
  b64Data = b64Data.trim();
  // Accept code blocks
  b64Data = b64Data.replace(/^```\s*/m, "").replace(/\s*```$/m, "");

  if (!b64Data) {
    return "Please provide your gogcli credentials as a base64-encoded tar archive.\n" +
      "On your machine, run:\n```\ncd ~/.config/gogcli && tar czf - . | base64\n```\n" +
      "Then paste the output after `!setup google `.";
  }

  // Validate it's base64
  try {
    Buffer.from(b64Data.slice(0, 100), "base64");
  } catch {
    return "That doesn't look like valid base64. Run `cd ~/.config/gogcli && tar czf - . | base64` and paste the full output.";
  }

  const credDir = resolvePath(user.credentialsDir);
  const gogDir = path.join(credDir, "gogcli");
  fs.mkdirSync(gogDir, { recursive: true, mode: 0o700 });

  // Save the base64 data to decode locally
  const tarData = Buffer.from(b64Data, "base64");
  execSync(`tar xzf - -C ${JSON.stringify(gogDir)}`, { input: tarData, timeout: 10000 });
  execSync(`chmod -R 700 ${JSON.stringify(gogDir)}`);

  // Inject into sandbox
  sshPipe(user.sandboxName, b64Data + "\n",
    "mkdir -p /sandbox/.config/gogcli && base64 -d | tar xzf - -C /sandbox/.config/gogcli && chmod -R 700 /sandbox/.config/gogcli");

  let msg = `Google (gogcli) credentials saved and injected into sandbox \`${user.sandboxName}\`.`;
  const hb = trySetupHeartbeatCron(user);
  if (hb) msg += hb;
  return msg;
}

function setupPersonality(user, content) {
  content = content.trim();
  if (!content) {
    return "Please provide your personality text after the command.\n" +
      "Example: `!setup personality You are a helpful coding assistant named Alice. You are friendly and concise.`";
  }

  const workspaceDir = resolvePath(user.personalityDir);
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Save SOUL.md locally
  fs.writeFileSync(path.join(workspaceDir, "SOUL.md"), content);

  // Inject into sandbox
  const b64 = Buffer.from(content).toString("base64");
  sshPipe(user.sandboxName, b64 + "\n",
    "base64 -d > /sandbox/.openclaw/workspace/SOUL.md");

  return `Agent personality (SOUL.md) updated in sandbox \`${user.sandboxName}\`.`;
}

function setupHeartbeat(user, content) {
  content = content.trim();
  if (!content) {
    return "Please provide your heartbeat instructions after the command.\n" +
      "This controls what your agent checks periodically (email, calendar, etc.).\n" +
      "Example: `!setup heartbeat Check my Gmail for urgent emails. Check my Google Calendar for meetings in the next 2 hours. Send a summary to Slack.`";
  }

  const workspaceDir = resolvePath(user.personalityDir);
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Save HEARTBEAT.md locally
  fs.writeFileSync(path.join(workspaceDir, "HEARTBEAT.md"), content);

  // Inject into sandbox
  const b64 = Buffer.from(content).toString("base64");
  sshPipe(user.sandboxName, b64 + "\n",
    "base64 -d > /sandbox/.openclaw/workspace/HEARTBEAT.md");

  let msg = `Heartbeat instructions (HEARTBEAT.md) updated in sandbox \`${user.sandboxName}\`.`;
  const hb = trySetupHeartbeatCron(user);
  if (hb) msg += hb;
  return msg;
}

function setupIdentity(user, content) {
  content = content.trim();
  if (!content) {
    return "Please provide your agent identity/name after the command.\n" +
      "Example: `!setup identity You are Alice, a personal AI assistant.`";
  }

  const workspaceDir = resolvePath(user.personalityDir);
  fs.mkdirSync(workspaceDir, { recursive: true });

  fs.writeFileSync(path.join(workspaceDir, "IDENTITY.md"), content);

  const b64 = Buffer.from(content).toString("base64");
  sshPipe(user.sandboxName, b64 + "\n",
    "base64 -d > /sandbox/.openclaw/workspace/IDENTITY.md");

  return `Agent identity (IDENTITY.md) updated in sandbox \`${user.sandboxName}\`.`;
}

function setupUser(user, content) {
  content = content.trim();
  if (!content) {
    return "Please provide context about yourself after the command.\n" +
      "This helps your agent understand who you are.\n" +
      "Example: `!setup user I'm Alice, a backend engineer at Acme Corp. I work on the payments service in Go.`";
  }

  const workspaceDir = resolvePath(user.personalityDir);
  fs.mkdirSync(workspaceDir, { recursive: true });

  fs.writeFileSync(path.join(workspaceDir, "USER.md"), content);

  const b64 = Buffer.from(content).toString("base64");
  sshPipe(user.sandboxName, b64 + "\n",
    "base64 -d > /sandbox/.openclaw/workspace/USER.md");

  return `User context (USER.md) updated in sandbox \`${user.sandboxName}\`.`;
}

function setupFreshrelease(user, key) {
  key = key.trim();
  // Accept code blocks
  key = key.replace(/^```\s*/m, "").replace(/\s*```$/m, "").trim();

  if (!key) {
    return "Please provide your Freshrelease API key after the command.\n" +
      "Example: `!setup freshrelease <your-api-key>`\n" +
      "Get one from: Freshrelease → Profile → API Key";
  }

  // Persist to credentials dir
  const credDir = resolvePath(user.credentialsDir);
  fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(credDir, "freshrelease-api-key.txt"), key, { mode: 0o600 });

  // Patch Claude settings.json on the sandbox to add/update the Freshrelease MCP server
  // Use sshPipe + base64 to avoid shell escaping issues with multi-line Python
  const patchScript = `
import json, os, sys
path = '/sandbox/.claude/settings.json'
if not os.path.exists(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump({}, open(path, 'w'), indent=4)
cfg = json.load(open(path))
mcp = cfg.setdefault('mcpServers', {})
mcp['freshrelease'] = {
    'command': '/usr/local/bin/freshrelease-mcp',
    'args': [],
    'env': {
        'FRESHRELEASE_DOMAIN': 'freshworks.freshrelease.com',
        'FRESHRELEASE_API_KEY': '${key}'
    }
}
json.dump(cfg, open(path, 'w'), indent=4)
os.chmod(path, 0o600)
`;
  const scriptB64 = Buffer.from(patchScript).toString("base64");
  sshPipe(user.sandboxName, scriptB64 + "\n",
    "base64 -d | python3");

  return `Freshrelease API key saved and MCP server configured in sandbox \`${user.sandboxName}\`.\n` +
    "This does not configure Claude auth. Use `!setup claude` separately.";
}

function setupWebhook(user, url) {
  url = url.trim();
  if (!url.startsWith("https://hooks.slack.com/")) {
    return "Invalid webhook URL. Expected a URL starting with `https://hooks.slack.com/`.";
  }

  // Persist to credentials dir
  const credDir = resolvePath(user.credentialsDir);
  fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(credDir, "slack-webhook-url.txt"), url, { mode: 0o600 });

  // Inject into sandbox .env
  sshCmd(user.sandboxName,
    `grep -q SLACK_WEBHOOK_URL /sandbox/.env 2>/dev/null && sed -i 's|^SLACK_WEBHOOK_URL=.*|SLACK_WEBHOOK_URL=${url}|' /sandbox/.env || echo 'SLACK_WEBHOOK_URL=${url}' >> /sandbox/.env; chmod 600 /sandbox/.env`);

  let msg = `Slack webhook URL saved and injected into sandbox \`${user.sandboxName}\`.\n` +
    "Heartbeat notifications will use this webhook as a fallback if bot DM delivery fails.";
  const hb = trySetupHeartbeatCron(user);
  if (hb) msg += hb;
  return msg;
}

function setupTimezone(user, tz) {
  tz = tz.trim();
  if (!tz) {
    const current = user.timezone || "UTC";
    return `Your current timezone is \`${current}\`.\n` +
      "To change it, provide an IANA timezone name:\n" +
      "Example: `!setup timezone America/Los_Angeles`\n" +
      "Common values: `America/New_York`, `America/Chicago`, `America/Los_Angeles`, `Asia/Kolkata`, `Europe/London`, `UTC`";
  }

  // Basic validation: must look like Area/City or UTC
  if (tz !== "UTC" && !/^[A-Z][a-z]+\/[A-Z][a-z_]+/.test(tz)) {
    return `Invalid timezone: \`${tz}\`.\n` +
      "Use IANA format like `America/Los_Angeles`, `Asia/Kolkata`, or `UTC`.";
  }

  // Save to user registry
  userRegistry.updateUser(user.slackUserId, { timezone: tz });

  return `Timezone set to \`${tz}\` for ${user.slackDisplayName}.`;
}

function setupStatus(user) {
  const credDir = resolvePath(user.credentialsDir);
  const workspaceDir = resolvePath(user.personalityDir);

  const checks = {
    "Claude credentials": fs.existsSync(path.join(credDir, "claude-credentials.json")),
    "Claude Teams token": fs.existsSync(path.join(credDir, "claude-oauth-token.txt")),
    "GitHub token": fs.existsSync(path.join(credDir, "gh-hosts.yml")),
    "Google OAuth (gogcli)": fs.existsSync(path.join(credDir, "gogcli", "config.json")),
    "Freshrelease API key": fs.existsSync(path.join(credDir, "freshrelease-api-key.txt")),
    "Personality (SOUL.md)": fs.existsSync(path.join(workspaceDir, "SOUL.md")),
    "Identity (IDENTITY.md)": fs.existsSync(path.join(workspaceDir, "IDENTITY.md")),
    "Heartbeat (HEARTBEAT.md)": fs.existsSync(path.join(workspaceDir, "HEARTBEAT.md")),
    "User context (USER.md)": fs.existsSync(path.join(workspaceDir, "USER.md")),
  };

  let sandboxStatus = "unknown";
  try {
    const out = execSync("openshell sandbox list 2>&1", { encoding: "utf-8" });
    if (out.includes(user.sandboxName) && out.includes("Ready")) {
      sandboxStatus = "Ready";
    } else if (out.includes(user.sandboxName)) {
      sandboxStatus = "Not Ready";
    } else {
      sandboxStatus = "Not Found";
    }
  } catch {
    sandboxStatus = "cannot check";
  }

  const lines = [
    `*Setup status for ${user.slackDisplayName}*`,
    `Sandbox: \`${user.sandboxName}\` (${sandboxStatus})`,
    `Timezone: \`${user.timezone || "UTC"}\``,
    "",
  ];

  for (const [name, ok] of Object.entries(checks)) {
    lines.push(`${ok ? ":white_check_mark:" : ":x:"} ${name}`);
  }

  lines.push("");
  lines.push("_Credentials: DM me `!setup help` for commands._");

  return lines.join("\n");
}

function setupHelp() {
  return `*NemoClaw Self-Service Setup*

*Credentials* (send via DM only — your message will be deleted after processing):
• \`!setup github <token>\` — GitHub personal access token (ghp_...)
• \`!setup claude-token <token>\` — Recommended for Claude Teams users, especially on macOS. Run \`claude setup-token\` on your machine and paste the long-lived token
• \`!setup freshrelease <key>\` — Freshrelease API key for ticket management MCP
• \`!setup webhook <url>\` — Slack incoming webhook URL (optional override)
• \`!setup claude <json>\` — Secondary option for users whose Claude Code install stores OAuth JSON on disk. In practice this is mainly Linux users with \`~/.claude/.credentials.json\`
• \`!setup google <base64>\` — Google OAuth credentials
  _Run on your machine:_ \`cd ~/.config/gogcli && tar czf - . | base64\`

*Personalization* (safe to send in DM or channel):
• \`!setup personality <text>\` — Set your agent's personality (SOUL.md)
• \`!setup identity <text>\` — Set your agent's name/role (IDENTITY.md)
• \`!setup user <text>\` — Tell your agent about yourself (USER.md)
• \`!setup heartbeat <text>\` — Configure periodic checks (HEARTBEAT.md)
• \`!setup timezone <tz>\` — Set your timezone (e.g. \`America/Los_Angeles\`, \`Asia/Kolkata\`, \`UTC\`)

*Status:*
• \`!setup status\` — Check which credentials and files are configured

*Notifications:*
Heartbeat notifications (email/calendar alerts) are sent as DMs from this bot by default — no setup needed.
Use \`!setup webhook\` only if you want notifications posted to a specific channel instead.

*Claude Teams Note:*
Most MacBook users should use \`!setup claude-token <token>\` after running \`claude setup-token\`.
Use \`!setup claude <json>\` only if your machine actually has \`~/.claude/.credentials.json\` available, which is more common on Linux.

_All credential messages are deleted immediately after processing for security._`;
}

// ── Main dispatch ───────────────────────────────────────────────

const CREDENTIAL_COMMANDS = new Set(["github", "claude", "claude-token", "google", "webhook", "freshrelease"]);

/**
 * Handle a !setup command.
 * @param {object} user - User registry entry
 * @param {string} text - Full message text after "!setup "
 * @returns {{ response: string, deleteMessage: boolean }}
 */
function handleSetup(user, text) {
  const spaceIdx = text.indexOf(" ");
  const subcommand = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
  const arg = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1);

  let response;
  let deleteMessage = false;

  try {
    switch (subcommand.toLowerCase()) {
      case "github":
        response = setupGithub(user, arg);
        deleteMessage = true;
        break;
      case "claude":
        response = setupClaude(user, arg);
        deleteMessage = true;
        break;
      case "claude-token":
        response = setupClaudeToken(user, arg);
        deleteMessage = true;
        break;
      case "google":
        response = setupGoogle(user, arg);
        deleteMessage = true;
        break;
      case "webhook":
        response = setupWebhook(user, arg);
        deleteMessage = true;
        break;
      case "freshrelease":
        response = setupFreshrelease(user, arg);
        deleteMessage = true;
        break;
      case "personality":
        response = setupPersonality(user, arg);
        break;
      case "identity":
        response = setupIdentity(user, arg);
        break;
      case "user":
        response = setupUser(user, arg);
        break;
      case "heartbeat":
        response = setupHeartbeat(user, arg);
        break;
      case "timezone":
        response = setupTimezone(user, arg);
        break;
      case "status":
        response = setupStatus(user);
        break;
      case "help":
        response = setupHelp();
        break;
      default:
        response = `Unknown setup command: \`${subcommand}\`. Run \`!setup help\` for available commands.`;
        break;
    }
  } catch (err) {
    response = `Setup failed: ${err.message}`;
    // Still delete credential messages even on error
    deleteMessage = CREDENTIAL_COMMANDS.has(subcommand.toLowerCase());
  }

  return { response, deleteMessage };
}

/**
 * Normalize text: strip invisible Unicode chars (zero-width spaces, BOM, etc.)
 * and collapse whitespace. Mobile keyboards (especially on Android/iOS) often
 * insert these, causing exact string matches to fail.
 */
function normalizeText(text) {
  return text
    .replace(/[\u200B-\u200D\uFEFF\u00AD\u2060\u180E]/g, "") // zero-width / invisible chars
    .replace(/\u00A0/g, " ") // non-breaking space → regular space
    .replace(/\s+/g, " ")    // collapse whitespace
    .trim();
}

/**
 * Check if text is a !setup command.
 */
function isSetupCommand(text) {
  return normalizeText(text).toLowerCase().startsWith("!setup");
}

module.exports = {
  handleSetup,
  isSetupCommand,
  normalizeText,
  setupHelp,
};
