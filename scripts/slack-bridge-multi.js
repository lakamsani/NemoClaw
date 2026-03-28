#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-user Slack -> NemoClaw bridge.
 *
 * Routes messages to different sandboxes based on Slack user ID,
 * using the user registry (~/.nemoclaw/users.json) for lookup.
 *
 * Uses Socket Mode (no public URL required).
 *
 * Env:
 *   SLACK_BOT_TOKEN   — Bot User OAuth Token (xoxb-...)
 *   SLACK_APP_TOKEN   — App-Level Token with connections:write (xapp-...)
 *   NVIDIA_API_KEY    — for inference
 *   ALLOWED_CHANNELS  — comma-separated Slack channel IDs to accept (optional, accepts all if unset)
 *   SLACK_ADMIN_USERS — comma-separated Slack user IDs treated as admins on DGX
 */

const { execFileSync, execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const userRegistry = require("../bin/lib/user-registry");
const sandboxRegistry = require("../bin/lib/registry");
const { isSetupCommand, handleSetup, setupHelp, normalizeText } = require("../bin/lib/credential-setup");

const OPENSHELL = resolveOpenshell();

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const API_KEY = process.env.NVIDIA_API_KEY;
const ALLOWED_CHANNELS = process.env.ALLOWED_CHANNELS
  ? process.env.ALLOWED_CHANNELS.split(",").map((s) => s.trim())
  : null;
const ADMIN_USERS = new Set(
  (process.env.SLACK_ADMIN_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// ── Credential refresh on auth failure ────────────────────────────

const REPO_DIR = require("path").resolve(__dirname, "..");
const AUTH_ERROR_RE = /authentication_error|invalid_grant|Invalid authentication|401.*auth|expired.*token|OAuth token has expired/i;
const ADMIN_AUDIT_LOG = `${REPO_DIR}/persist/audit/admin-actions.log`;
const pendingDeleteRequests = new Map();
const DELETE_CONFIRM_TTL_MS = 5 * 60 * 1000;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_GITHUB_HANDLE_LENGTH = 39;
const SHARED_CLAUDE_CREDENTIALS = process.env.NEMOCLAW_SHARED_CLAUDE_CREDENTIALS
  || path.join(process.env.HOME || "/tmp", ".claude", ".credentials.json");
const SHARED_CLAUDE_SETTINGS = process.env.NEMOCLAW_SHARED_CLAUDE_SETTINGS
  || path.join(process.env.HOME || "/tmp", ".claude", "settings.json");
const SHARED_CLAUDE_MCP_CACHE = process.env.NEMOCLAW_SHARED_CLAUDE_MCP_CACHE
  || path.join(process.env.HOME || "/tmp", ".claude", "mcp-needs-auth-cache.json");

function withAdminState(user) {
  if (!user) return null;
  const roles = new Set(user.roles || ["user"]);
  roles.add("user");
  if (ADMIN_USERS.has(user.slackUserId)) roles.add("admin");
  return { ...user, roles: [...roles] };
}

function getUser(slackUserId) {
  const user = withAdminState(userRegistry.getUser(slackUserId));
  return user && user.enabled ? user : null;
}

function isAdminUser(user) {
  return !!(user && Array.isArray(user.roles) && user.roles.includes("admin"));
}

function isListAdminsCommand(text) {
  const normalized = normalizeText(text).toLowerCase();
  return normalized === "!admins" || normalized === "!admins list" || normalized === "!admin-users";
}

function isAdminAuditCommand(text) {
  const normalized = normalizeText(text).toLowerCase();
  return normalized === "!admin-audit" || normalized === "!admin-audit 10" || normalized === "!admin-log";
}

function isShowClawsCommand(text) {
  const normalized = normalizeText(text).toLowerCase();
  return normalized.startsWith("!show-claws") || normalized === "!claws" || normalized.startsWith("!list-claws");
}

function isShowUserCommand(text) {
  const normalized = normalizeText(text).toLowerCase();
  return normalized.startsWith("!show-user");
}

function isAdminHelpCommand(text) {
  const normalized = normalizeText(text).toLowerCase();
  return normalized === "!admin-help" || normalized === "!help-admin";
}

function parseCommandArgs(text) {
  const args = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
}

function auditAdminAction(actor, action, details = {}, outcome = "started", error = "") {
  fs.mkdirSync(`${REPO_DIR}/persist/audit`, { recursive: true });
  const record = {
    ts: new Date().toISOString(),
    actorSlackUserId: actor?.slackUserId || "",
    actorDisplayName: actor?.slackDisplayName || "",
    action,
    outcome,
    details,
    error,
  };
  fs.appendFileSync(ADMIN_AUDIT_LOG, `${JSON.stringify(record)}\n`, "utf-8");
}

function runAdminCommand(file, args = [], timeout = 300000) {
  return execFileSync(file, args, {
    cwd: REPO_DIR,
    encoding: "utf-8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function getProvisioningSummary(slackId, clawName) {
  try {
    const statusOutput = runAdminCommand(process.execPath, [
      "bin/nemoclaw.js",
      "user-status",
      slackId,
    ], 120000).trim();
    return statusOutput.slice(-2500) || "(no status output)";
  } catch (err) {
    const output = `${err.stdout || ""}${err.stderr || ""}`.trim() || err.message;
    return `Status verification failed for ${clawName}:\n${output.slice(-2500)}`;
  }
}

function isAddClawCommand(text) {
  return normalizeText(text).toLowerCase().startsWith("!add-claw");
}

function isDeleteClawCommand(text) {
  return normalizeText(text).toLowerCase().startsWith("!delete-claw");
}

function isConfirmDeleteClawCommand(text) {
  return normalizeText(text).toLowerCase().startsWith("!confirm-delete-claw");
}

function listAdminUsers() {
  return buildAdminUserList(userRegistry.listUsers().users, ADMIN_USERS);
}

function buildAdminUserList(users, adminUserIds = ADMIN_USERS) {
  const admins = new Map();

  for (const entry of users) {
    const user = withAdminState({
      ...entry,
      roles: Array.isArray(entry.roles) ? entry.roles : ["user"],
    });
    if (user && user.roles.includes("admin")) {
      admins.set(user.slackUserId, user);
    }
  }

  for (const slackUserId of adminUserIds) {
    if (!admins.has(slackUserId)) {
      admins.set(slackUserId, {
        slackUserId,
        slackDisplayName: slackUserId,
        sandboxName: "",
        roles: ["user", "admin"],
        enabled: false,
      });
    }
  }

  return [...admins.values()].sort((a, b) =>
    (a.slackDisplayName || a.slackUserId).localeCompare(b.slackDisplayName || b.slackUserId)
  );
}

function formatAdminUsers() {
  return formatAdminUsersFromList(listAdminUsers());
}

function formatAdminUsersFromList(admins) {
  if (admins.length === 0) {
    return "No admin users are configured.";
  }

  const lines = ["*Admin Users*"];
  for (const admin of admins) {
    const label = admin.slackDisplayName || admin.slackUserId;
    const sandbox = admin.sandboxName ? ` — sandbox: \`${admin.sandboxName}\`` : "";
    const status = admin.enabled ? "" : " _(allowlist only or disabled)_";
    lines.push(`• ${label} (\`${admin.slackUserId}\`)${sandbox}${status}`);
  }
  return lines.join("\n");
}

function readRecentAdminAudit(limit = 10) {
  if (!fs.existsSync(ADMIN_AUDIT_LOG)) return [];
  const lines = fs.readFileSync(ADMIN_AUDIT_LOG, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit);
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function formatRecentAdminAudit(limit = 10) {
  const records = readRecentAdminAudit(limit);
  if (records.length === 0) return "No admin audit records found.";
  const lines = [`*Recent Admin Actions* (last ${records.length})`];
  for (const record of records.reverse()) {
    const actor = record.actorDisplayName || record.actorSlackUserId || "unknown";
    const target = record.details?.clawName || record.details?.slackId || "";
    const suffix = target ? ` — ${target}` : "";
    lines.push(`• ${record.ts} — ${actor} — ${record.action} — ${record.outcome}${suffix}`);
  }
  return lines.join("\n");
}

function formatAdminHelp() {
  return [
    "*Admin Commands*",
    "`!admin-help`",
    "`!admins`",
    "`!admin-audit`",
    "`!show-claws [ready|not-ready|registered|unregistered|admins|non-admins|gpu] [sort=name|user|status|uptime] [match=...] [policy=...] [cred=...]`",
    "`!show-user <slack-id|claw-name|name-fragment>`",
    "`!add-claw <slack_id> <display_name> <claw_name> <github_handle>`",
    "`!delete-claw <claw_name>`",
    "`!confirm-delete-claw <claw_name>`",
    "",
    `Delete confirmations expire after ${Math.floor(DELETE_CONFIRM_TTL_MS / 60000)} minutes and are lost if the bridge restarts.`,
  ].join("\n");
}

function parseSandboxList(raw) {
  const sandboxes = new Map();
  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!trimmed || trimmed.startsWith("NAME ")) continue;
    const match = trimmed.match(/^(\S+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)$/);
    if (!match) continue;
    const [, name, namespace, createdAt, phase] = match;
    sandboxes.set(name, {
      name,
      namespace,
      createdAt,
      phase,
    });
  }
  return sandboxes;
}

function loadLiveSandboxMap() {
  try {
    const output = execSync(`"${OPENSHELL}" sandbox list`, {
      cwd: REPO_DIR,
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseSandboxList(output);
  } catch {
    return new Map();
  }
}

function formatDurationFrom(dateLike) {
  if (!dateLike) return "unknown";
  const started = new Date(String(dateLike).replace(" ", "T") + (String(dateLike).includes("T") ? "" : "Z"));
  if (Number.isNaN(started.getTime())) return "unknown";
  let seconds = Math.max(0, Math.floor((Date.now() - started.getTime()) / 1000));
  const days = Math.floor(seconds / 86400);
  seconds -= days * 86400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getInventoryStatus(item) {
  return item.liveSandbox?.phase || (item.registrySandbox ? "Registry only" : "Unknown");
}

function getClaudeCredentialSource(user) {
  if (!user?.credentialsDir) return { mode: "missing", path: "" };
  const credDir = path.isAbsolute(user.credentialsDir)
    ? user.credentialsDir
    : path.join(REPO_DIR, user.credentialsDir);
  const perUserPath = path.join(credDir, "claude-credentials.json");
  if (fs.existsSync(perUserPath)) {
    return { mode: "per-user", path: perUserPath };
  }
  if (fs.existsSync(SHARED_CLAUDE_CREDENTIALS)) {
    return { mode: "shared-org", path: SHARED_CLAUDE_CREDENTIALS };
  }
  return { mode: "missing", path: "" };
}

function describeClaudeCredentialSource(user) {
  const source = getClaudeCredentialSource(user);
  if (source.mode === "per-user") return "per-user";
  if (source.mode === "shared-org") return `shared org fallback (\`${source.path}\`)`;
  return "not configured";
}

function describeClaudeSupportFiles() {
  const details = [];
  if (fs.existsSync(SHARED_CLAUDE_SETTINGS)) details.push(`settings: \`${SHARED_CLAUDE_SETTINGS}\``);
  if (fs.existsSync(SHARED_CLAUDE_MCP_CACHE)) details.push(`mcp cache: \`${SHARED_CLAUDE_MCP_CACHE}\``);
  return details.length ? details.join(", ") : "none";
}

function listConfiguredCredentials(user) {
  if (!user?.credentialsDir) return [];
  const credDir = path.isAbsolute(user.credentialsDir)
    ? user.credentialsDir
    : path.join(REPO_DIR, user.credentialsDir);
  const configured = [];
  const checks = [
    ["Claude OAuth", path.join(credDir, "claude-credentials.json")],
    ["Anthropic API key", path.join(credDir, "anthropic-key.txt")],
    ["GitHub", path.join(credDir, "gh-hosts.yml")],
    ["Google (gogcli)", path.join(credDir, "gogcli", "config.json")],
    ["Freshrelease", path.join(credDir, "freshrelease-api-key.txt")],
    ["Slack webhook", path.join(credDir, "slack-webhook-url.txt")],
  ];

  for (const [label, file] of checks) {
    if (fs.existsSync(file)) configured.push(label);
  }
  return configured;
}

function buildClawInventory() {
  const { users } = userRegistry.listUsers();
  const userBySandbox = new Map(users.map((user) => [user.sandboxName, withAdminState(user)]));
  const registrySandboxes = sandboxRegistry.listSandboxes().sandboxes;
  const registryByName = new Map(registrySandboxes.map((sandbox) => [sandbox.name, sandbox]));
  const liveByName = loadLiveSandboxMap();
  const names = new Set([
    ...userBySandbox.keys(),
    ...registryByName.keys(),
    ...liveByName.keys(),
  ]);

  return [...names]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const user = userBySandbox.get(name) || null;
      const registrySandbox = registryByName.get(name) || null;
      const liveSandbox = liveByName.get(name) || null;
      const policies = Array.isArray(registrySandbox?.policies) ? registrySandbox.policies : [];
      const credentials = listConfiguredCredentials(user);
      return {
        name,
        user,
        registrySandbox,
        liveSandbox,
        policies,
        credentials,
      };
    });
}

function parseShowClawsOptions(text) {
  const args = parseCommandArgs(text).slice(1);
  const options = {
    filters: [],
    sort: "name",
    match: "",
    policy: "",
    credential: "",
  };

  for (const arg of args) {
    const lower = String(arg).toLowerCase();
    if (lower.startsWith("sort=")) {
      options.sort = lower.slice(5) || "name";
      continue;
    }
    if (lower.startsWith("match=") || lower.startsWith("user=") || lower.startsWith("claw=")) {
      options.match = arg.slice(arg.indexOf("=") + 1).trim();
      continue;
    }
    if (lower.startsWith("policy=")) {
      options.policy = arg.slice(arg.indexOf("=") + 1).trim().toLowerCase();
      continue;
    }
    if (lower.startsWith("cred=") || lower.startsWith("credential=")) {
      options.credential = arg.slice(arg.indexOf("=") + 1).trim().toLowerCase();
      continue;
    }
    if (lower) options.filters.push(lower);
  }

  return options;
}

function filterAndSortClawInventory(inventory, options = {}) {
  let result = [...inventory];
  const filters = new Set(options.filters || []);
  const match = (options.match || "").toLowerCase();
  const policy = (options.policy || "").toLowerCase();
  const credential = (options.credential || "").toLowerCase();

  if (filters.has("ready")) {
    result = result.filter((item) => getInventoryStatus(item).toLowerCase() === "ready");
  }
  if (filters.has("not-ready")) {
    result = result.filter((item) => getInventoryStatus(item).toLowerCase() !== "ready");
  }
  if (filters.has("registry-only")) {
    result = result.filter((item) => getInventoryStatus(item).toLowerCase() === "registry only");
  }
  if (filters.has("registered")) {
    result = result.filter((item) => !!item.user);
  }
  if (filters.has("unregistered")) {
    result = result.filter((item) => !item.user);
  }
  if (filters.has("admins")) {
    result = result.filter((item) => isAdminUser(item.user));
  }
  if (filters.has("non-admins")) {
    result = result.filter((item) => item.user && !isAdminUser(item.user));
  }
  if (filters.has("gpu")) {
    result = result.filter((item) => !!item.registrySandbox?.gpuEnabled);
  }

  if (match) {
    result = result.filter((item) => {
      const haystack = [
        item.name,
        item.user?.slackUserId,
        item.user?.slackDisplayName,
        item.user?.githubUser,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(match);
    });
  }

  if (policy) {
    result = result.filter((item) => item.policies.some((entry) => entry.toLowerCase().includes(policy)));
  }

  if (credential) {
    result = result.filter((item) => item.credentials.some((entry) => entry.toLowerCase().includes(credential)));
  }

  const sort = (options.sort || "name").toLowerCase();
  result.sort((a, b) => {
    if (sort === "user") {
      return (a.user?.slackDisplayName || a.user?.slackUserId || "").localeCompare(b.user?.slackDisplayName || b.user?.slackUserId || "");
    }
    if (sort === "status") {
      return getInventoryStatus(a).localeCompare(getInventoryStatus(b));
    }
    if (sort === "uptime" || sort === "created") {
      const aTime = new Date((a.liveSandbox?.createdAt || a.registrySandbox?.createdAt || a.user?.createdAt || "").replace(" ", "T") + "Z").getTime() || 0;
      const bTime = new Date((b.liveSandbox?.createdAt || b.registrySandbox?.createdAt || b.user?.createdAt || "").replace(" ", "T") + "Z").getTime() || 0;
      return aTime - bTime;
    }
    return a.name.localeCompare(b.name);
  });

  return result;
}

function formatClawInventory(inventory) {
  if (inventory.length === 0) {
    return "No claws found in the user or sandbox registries.";
  }

  const lines = ["*Claw Inventory*"];
  for (const item of inventory) {
    const userLabel = item.user
      ? `${item.user.slackDisplayName || item.user.slackUserId} (\`${item.user.slackUserId}\`)`
      : "_unregistered_";
    const github = item.user?.githubUser ? `\`${item.user.githubUser}\`` : "_none_";
    const livePhase = getInventoryStatus(item);
    const uptimeSource = item.liveSandbox?.createdAt || item.registrySandbox?.createdAt || item.user?.createdAt || null;
    const uptime = formatDurationFrom(uptimeSource);
    const credentials = item.credentials.length > 0 ? item.credentials.join(", ") : "none";
    const policies = item.policies.length > 0 ? item.policies.join(", ") : "none";
    const provider = item.registrySandbox?.provider ? `, provider=${item.registrySandbox.provider}` : "";
    const gpu = item.registrySandbox?.gpuEnabled ? ", gpu=true" : "";
    lines.push(`• \`${item.name}\` — ${livePhase}, up ${uptime}`);
    lines.push(`  user: ${userLabel}`);
    lines.push(`  github: ${github}`);
    lines.push(`  credentials: ${credentials}`);
    lines.push(`  policies: ${policies}${provider}${gpu}`);
  }
  return lines.join("\n");
}

function formatShowClaws() {
  return formatClawInventory(buildClawInventory());
}

function truncateCell(value, max = 120) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function buildShowClawsTablePayloadFromInventory(inventory, fallbackText = formatClawInventory(inventory)) {
  if (inventory.length === 0) {
    return { text: fallbackText };
  }

  const rows = [
    [
      { type: "raw_text", text: "Claw" },
      { type: "raw_text", text: "User" },
      { type: "raw_text", text: "Status" },
      { type: "raw_text", text: "GitHub" },
      { type: "raw_text", text: "Credentials" },
      { type: "raw_text", text: "Policies" },
    ],
    ...inventory.map((item) => {
      const userLabel = item.user
        ? `${item.user.slackDisplayName || item.user.slackUserId} (${item.user.slackUserId})`
        : "unregistered";
      const status = `${getInventoryStatus(item)} • ${formatDurationFrom(item.liveSandbox?.createdAt || item.registrySandbox?.createdAt || item.user?.createdAt || null)}`;
      const github = item.user?.githubUser || "none";
      const credentials = item.credentials.length > 0 ? item.credentials.join(", ") : "none";
      const policies = [
        ...(item.policies.length > 0 ? item.policies : ["none"]),
        item.registrySandbox?.provider ? `provider=${item.registrySandbox.provider}` : null,
        item.registrySandbox?.gpuEnabled ? "gpu=true" : null,
      ].filter(Boolean).join(", ");

      return [
        { type: "raw_text", text: truncateCell(item.name, 40) },
        { type: "raw_text", text: truncateCell(userLabel, 60) },
        { type: "raw_text", text: truncateCell(status, 40) },
        { type: "raw_text", text: truncateCell(github, 30) },
        { type: "raw_text", text: truncateCell(credentials, 120) },
        { type: "raw_text", text: truncateCell(policies, 120) },
      ];
    }),
  ];

  return {
    text: `Claw inventory (${inventory.length})`,
    attachments: [
      {
        blocks: [
          {
            type: "table",
            column_settings: [
              { is_wrapped: true },
              { is_wrapped: true },
              { is_wrapped: true },
              { is_wrapped: true },
              { is_wrapped: true },
              { is_wrapped: true },
            ],
            rows,
          },
        ],
      },
    ],
  };
}

function buildShowClawsTablePayload() {
  return buildShowClawsTablePayloadFromInventory(buildClawInventory());
}

function buildShowClawsPayload(text) {
  const options = parseShowClawsOptions(text);
  const inventory = filterAndSortClawInventory(buildClawInventory(), options);

  if (inventory.length === 0) {
    return { text: "No claws matched the requested filters." };
  }

  const payload = buildShowClawsTablePayloadFromInventory(inventory);
  const summary = [
    options.filters.length ? `filters=${options.filters.join(",")}` : "",
    options.match ? `match=${options.match}` : "",
    options.policy ? `policy=${options.policy}` : "",
    options.credential ? `cred=${options.credential}` : "",
    options.sort !== "name" ? `sort=${options.sort}` : "",
  ].filter(Boolean).join(" | ");

  if (summary) {
    payload.text = `Claw inventory (${inventory.length}) — ${summary}`;
  }

  return payload;
}

function resolveUserLookup(token) {
  const query = String(token || "").trim();
  if (!query) return null;
  const lower = query.toLowerCase();
  if (/^U[A-Z0-9]+$/.test(query)) return withAdminState(userRegistry.getUser(query));
  const bySandbox = userRegistry.getUserBySandbox(query);
  if (bySandbox) return withAdminState(bySandbox);
  const { users } = userRegistry.listUsers();
  return withAdminState(users.find((entry) =>
    entry.slackDisplayName?.toLowerCase().includes(lower) ||
    entry.githubUser?.toLowerCase().includes(lower) ||
    entry.sandboxName?.toLowerCase().includes(lower)
  )) || null;
}

function buildShowUserText(user) {
  if (!user) {
    return "User not found. Usage: `!show-user <slack-id|claw-name|name-fragment>`";
  }

  const registrySandbox = sandboxRegistry.getSandbox(user.sandboxName);
  const liveSandbox = loadLiveSandboxMap().get(user.sandboxName);
  const credentials = listConfiguredCredentials(user);
  const policies = Array.isArray(registrySandbox?.policies) ? registrySandbox.policies : [];
  return [
    "*User Detail*",
    `User: ${user.slackDisplayName || user.slackUserId} (\`${user.slackUserId}\`)`,
    `Claw: \`${user.sandboxName}\``,
    `Enabled: ${user.enabled ? "yes" : "no"}`,
    `Roles: ${(user.roles || ["user"]).join(", ")}`,
    `Timezone: \`${user.timezone || "UTC"}\``,
    `GitHub: ${user.githubUser ? `\`${user.githubUser}\`` : "_none_"}`,
    `Status: ${liveSandbox?.phase || "Not Found"}`,
    `Up For: ${formatDurationFrom(liveSandbox?.createdAt || registrySandbox?.createdAt || user.createdAt)}`,
    `Claude Auth: ${describeClaudeCredentialSource(user)}`,
    `Shared Claude Support: ${describeClaudeSupportFiles()}`,
    `Credentials: ${credentials.length ? credentials.join(", ") : "none"}`,
    `Policies: ${policies.length ? policies.join(", ") : "none"}`,
  ].join("\n");
}

function buildShowUserPayload(text) {
  const args = parseCommandArgs(text).slice(1);
  return { text: buildShowUserText(resolveUserLookup(args.join(" "))) };
}

function formatAddClawUsage() {
  return "Usage: `!add-claw <slack_id> <display_name> <claw_name> <github_handle>`\nExample: `!add-claw U12345ABC \"Jane Doe\" jane-claw janedoe`";
}

async function handleAddClaw(user, text) {
  const args = parseCommandArgs(text).slice(1);
  if (args.length < 4) {
    return { ok: false, message: formatAddClawUsage() };
  }

  const [slackId, displayName, clawName, githubHandle] = args;
  if (!/^U[A-Z0-9]+$/.test(slackId)) {
    return { ok: false, message: `Invalid Slack user ID: \`${slackId}\`.\n${formatAddClawUsage()}` };
  }
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(clawName)) {
    return { ok: false, message: `Invalid claw name: \`${clawName}\`.` };
  }
  if (!displayName.trim() || !githubHandle.trim()) {
    return { ok: false, message: formatAddClawUsage() };
  }
  if (displayName.trim().length > MAX_DISPLAY_NAME_LENGTH) {
    return { ok: false, message: `Display name is too long. Limit is ${MAX_DISPLAY_NAME_LENGTH} characters.` };
  }
  if (!/^[A-Za-z0-9-]+$/.test(githubHandle) || githubHandle.length > MAX_GITHUB_HANDLE_LENGTH) {
    return {
      ok: false,
      message: `Invalid GitHub handle: \`${githubHandle}\`. Use letters, numbers, hyphens, and at most ${MAX_GITHUB_HANDLE_LENGTH} characters.`,
    };
  }

  auditAdminAction(user, "add-claw", { slackId, displayName, clawName, githubHandle }, "started");

  try {
    const userAddOutput = runAdminCommand(process.execPath, [
      "bin/nemoclaw.js",
      "user-add",
      "--non-interactive",
      "--slack-id",
      slackId,
      "--display-name",
      displayName,
      "--claw-name",
      clawName,
      "--github-user",
      githubHandle,
    ]);
    const resilienceOutput = runAdminCommand("bash", [
      "scripts/nemoclaw-resilience.sh",
      "--sandbox",
      clawName,
      "--cred-dir",
      `persist/users/${slackId}/credentials`,
      "--github-user",
      githubHandle,
      "--slack-user-id",
      slackId,
    ], 600000);
    const statusSummary = getProvisioningSummary(slackId, clawName);
    auditAdminAction(user, "add-claw", { slackId, displayName, clawName, githubHandle }, "succeeded");
    return {
      ok: true,
      message: [
        `Created claw \`${clawName}\` for ${displayName} (\`${slackId}\`).`,
        `GitHub: \`${githubHandle}\``,
        "",
        "*user-add output*",
        "```",
        userAddOutput.trim().slice(-2500) || "(no output)",
        "```",
        "",
        "*resilience output*",
        "```",
        resilienceOutput.trim().slice(-2500) || "(no output)",
        "```",
        "",
        "*verification*",
        "```",
        statusSummary,
        "```",
        "",
        `Claude auth source: ${describeClaudeCredentialSource(userRegistry.getUser(slackId) || { credentialsDir: `persist/users/${slackId}/credentials` })}`,
      ].join("\n"),
    };
  } catch (err) {
    const output = `${err.stdout || ""}${err.stderr || ""}`.trim() || err.message;
    auditAdminAction(user, "add-claw", { slackId, displayName, clawName, githubHandle }, "failed", output.slice(0, 1000));
    return {
      ok: false,
      message: `Failed to create claw \`${clawName}\`.\n\`\`\`\n${output.slice(-3500)}\n\`\`\``,
    };
  }
}

async function handleDeleteClaw(user, text) {
  const args = parseCommandArgs(text).slice(1);
  if (args.length !== 1) {
    return {
      ok: false,
      message: "Usage: `!delete-claw <claw_name>`\nExample: `!delete-claw alice-claw`",
    };
  }

  const clawName = args[0];
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(clawName)) {
    return { ok: false, message: `Invalid claw name: \`${clawName}\`.` };
  }

  const targetUser = userRegistry.getUserBySandbox(clawName);
  if (!targetUser) {
    return { ok: false, message: `No registered claw found for \`${clawName}\`.` };
  }

  pendingDeleteRequests.set(user.slackUserId, {
    clawName,
    requestedAt: Date.now(),
  });
  auditAdminAction(user, "delete-claw-requested", { clawName, targetSlackUserId: targetUser.slackUserId }, "started");
  return {
    ok: true,
    message: [
      `Delete request staged for \`${clawName}\` owned by ${targetUser.slackDisplayName || targetUser.slackUserId} (\`${targetUser.slackUserId}\`).`,
      "This will destroy the sandbox, remove the user registry entry, and delete all persist data.",
      `Confirmation expires in ${Math.floor(DELETE_CONFIRM_TTL_MS / 60000)} minutes.`,
      "If the bridge restarts before you confirm, the staged delete is discarded and you must run `!delete-claw` again.",
      `If you want to continue, reply with: \`!confirm-delete-claw ${clawName}\``,
    ].join("\n"),
  };
}

async function handleConfirmDeleteClaw(user, text) {
  const args = parseCommandArgs(text).slice(1);
  if (args.length !== 1) {
    return {
      ok: false,
      message: "Usage: `!confirm-delete-claw <claw_name>`",
    };
  }

  const clawName = args[0];
  const pending = pendingDeleteRequests.get(user.slackUserId);
  if (pending && Date.now() - pending.requestedAt > DELETE_CONFIRM_TTL_MS) {
    pendingDeleteRequests.delete(user.slackUserId);
  }
  const activePending = pendingDeleteRequests.get(user.slackUserId);
  if (!activePending || activePending.clawName !== clawName) {
    return {
      ok: false,
      message: `No active pending delete request found for \`${clawName}\`. It may have expired or been lost during a bridge restart. Start again with \`!delete-claw ${clawName}\`.`,
    };
  }

  pendingDeleteRequests.delete(user.slackUserId);
  auditAdminAction(user, "delete-claw-confirmed", { clawName }, "started");

  try {
    const purgeOutput = runAdminCommand(process.execPath, [
      "bin/nemoclaw.js",
      "user-purge",
      "--sandbox",
      clawName,
    ], 600000);
    auditAdminAction(user, "delete-claw-confirmed", { clawName }, "succeeded");
    return {
      ok: true,
      message: [
        `Deleted claw \`${clawName}\`.`,
        "",
        "```",
        purgeOutput.trim().slice(-3000) || "(no output)",
        "```",
      ].join("\n"),
    };
  } catch (err) {
    const output = `${err.stdout || ""}${err.stderr || ""}`.trim() || err.message;
    auditAdminAction(user, "delete-claw-confirmed", { clawName }, "failed", output.slice(0, 1000));
    return {
      ok: false,
      message: `Failed to delete claw \`${clawName}\`.\n\`\`\`\n${output.slice(-3500)}\n\`\`\``,
    };
  }
}

function refreshCredentials(sandboxName, credDir = "") {
  console.log(`[refresh] Triggering credential refresh for ${sandboxName}...`);
  try {
    const args = [path.join(REPO_DIR, "scripts", "refresh-credentials.sh"), sandboxName];
    if (credDir) {
      args.push("--cred-dir", credDir);
    }
    execFileSync(args[0], args.slice(1), {
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    console.log(`[refresh] Credentials refreshed for ${sandboxName}`);
    return true;
  } catch (err) {
    console.error(`[refresh] Failed to refresh credentials for ${sandboxName}:`, err.message);
    return false;
  }
}

// ── Run agent inside sandbox ──────────────────────────────────────

function runAgentInSandbox(message, sessionId, user) {
  return new Promise((resolve) => {
    const sandboxName = user.sandboxName;
    let sshConfig;
    try {
      sshConfig = execSync(`"${OPENSHELL}" sandbox ssh-config "${sandboxName}"`, { encoding: "utf-8" });
    } catch (err) {
      resolve(`Error: Cannot reach sandbox '${sandboxName}'. Is it running?`);
      return;
    }

    const confPath = `/tmp/nemoclaw-slack-ssh-${sessionId}.conf`;
    fs.writeFileSync(confPath, sshConfig);

    const escaped = message.replace(/'/g, "'\\''");
    const cmd = `export NVIDIA_API_KEY='${sh(API_KEY)}' && export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache && export OPENCLAW_NO_RESPAWN=1 && export NEMOCLAW_SLACK_USER_ID='${sh(user.slackUserId)}' && export NEMOCLAW_SLACK_DISPLAY_NAME='${sh(user.slackDisplayName || user.slackUserId)}' && export NEMOCLAW_USER_ROLES='${sh((user.roles || ["user"]).join(","))}' && export NEMOCLAW_IS_ADMIN='${(user.roles || []).includes("admin") ? "1" : "0"}' && source /sandbox/.bashrc 2>/dev/null; nemoclaw-start openclaw agent --agent main --local -m '${escaped}' --session-id 'slack-${sessionId}'`;

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${sandboxName}`, cmd], {
      timeout: 600000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      try { fs.unlinkSync(confPath); } catch {}

      const lines = stdout.split("\n");
      const responseLines = lines.filter(
        (l) =>
          !l.startsWith("Setting up NemoClaw") &&
          !l.startsWith("[plugins]") &&
          !l.startsWith("[credentials]") &&
          !l.startsWith("[config]") &&
          !l.startsWith("[inject]") &&
          !l.startsWith("[gateway]") &&
          !l.startsWith("[auto-pair]") &&
          !l.startsWith("(node:") &&
          !l.includes("NemoClaw ready") &&
          !l.includes("NemoClaw registered") &&
          !l.includes("openclaw agent") &&
          !l.includes("\u250C\u2500") &&
          !l.includes("\u2502 ") &&
          !l.includes("\u2514\u2500") &&
          l.trim() !== "",
      );

      const response = responseLines.join("\n").trim();

      if (response) {
        resolve(response);
      } else if (code !== 0) {
        resolve(`Agent exited with code ${code}. ${stderr.trim().slice(0, 500)}`);
      } else {
        resolve("(no response)");
      }
    });

    proc.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  if (!OPENSHELL) {
    console.error("openshell not found on PATH or in common locations");
    process.exit(1);
  }
  if (!SLACK_BOT_TOKEN) { console.error("SLACK_BOT_TOKEN required"); process.exit(1); }
  if (!SLACK_APP_TOKEN) { console.error("SLACK_APP_TOKEN required"); process.exit(1); }
  if (!API_KEY) { console.error("NVIDIA_API_KEY required"); process.exit(1); }

  let App;
  try {
    ({ App } = require("@slack/bolt"));
  } catch {
    console.error("@slack/bolt not installed. Run: npm install @slack/bolt");
    process.exit(1);
  }

  const app = new App({
    token: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    socketMode: true,
    convoStore: false,   // disable built-in conversation store — avoids conversations.info calls
  });

  let botUserId = null;
  try {
    const authResult = await app.client.auth.test({ token: SLACK_BOT_TOKEN });
    botUserId = authResult.user_id;
  } catch {}

  // Load user registry and display registered users
  const { users } = userRegistry.listUsers();
  const userMap = {};
  for (const u of users) {
    const hydrated = withAdminState(u);
    if (hydrated && hydrated.enabled) {
      userMap[u.slackUserId] = hydrated;
    }
  }

  // Handle @mentions in channels — only allowed channels, ignore bots
  app.event("app_mention", async ({ event, say }) => {
    if (event.subtype) return;
    if (event.bot_id) return;
    if (event.user === botUserId) return;
    await handleMessage(event, say);
  });

  // Handle direct messages — only 1:1 DMs, ignore group DMs (mpim)
  app.event("message", async ({ event, say }) => {
    if (event.channel_type !== "im") return;
    if (event.subtype) return;
    if (event.bot_id) return;
    if (event.user === botUserId) return;
    await handleMessage(event, say);
  });

  async function handleMessage(event, say) {
    let channel = event.channel;
    const isDM = event.channel_type === "im";
    const threadTs = isDM ? event.thread_ts : (event.thread_ts || event.ts);

    // Ensure DM channel is open (fixes channel_not_found for new users)
    if (isDM) {
      try {
        const dm = await app.client.conversations.open({
          token: SLACK_BOT_TOKEN,
          users: event.user,
        });
        if (dm.channel && dm.channel.id) {
          channel = dm.channel.id;
        }
      } catch (e) {
        console.log(`[warn] conversations.open failed for ${event.user}: ${e.message}`);
      }
    }

    // Helper: send message to the resolved channel (avoids channel_not_found)
    async function reply(message) {
      const payload = typeof message === "string" ? { text: message } : message;
      await app.client.chat.postMessage({
        token: SLACK_BOT_TOKEN,
        channel,
        thread_ts: threadTs,
        ...payload,
      });
    }

    // Channel access control
    if (ALLOWED_CHANNELS && !ALLOWED_CHANNELS.includes(channel)) {
      console.log(`[ignored] channel ${channel} not in allowed list`);
      return;
    }

    // Strip bot mention from message text
    let text = event.text || "";
    if (botUserId) {
      text = text.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "").trim();
    }

    if (!text) return;

    // User registry lookup replaces ALLOWED_USERS
    const user = getUser(event.user);

    if (isListAdminsCommand(text)) {
      if (!user) {
        await reply("You're not registered with NemoClaw. Ask an admin to run: `nemoclaw user-add`\nYour Slack ID: `" + event.user + "`");
        return;
      }
      await reply(formatAdminUsers());
      return;
    }

    if (isAdminAuditCommand(text)) {
      if (!user) {
        await reply("You're not registered with NemoClaw. Ask an admin to run: `nemoclaw user-add`\nYour Slack ID: `" + event.user + "`");
        return;
      }
      if (!isAdminUser(user)) {
        await reply("You are registered, but you are not an admin user.");
        return;
      }
      await reply(formatRecentAdminAudit());
      return;
    }

    if (isAdminHelpCommand(text)) {
      if (!user) {
        await reply("You're not registered with NemoClaw. Ask an admin to run: `nemoclaw user-add`\nYour Slack ID: `" + event.user + "`");
        return;
      }
      if (!isAdminUser(user)) {
        await reply("You are registered, but you are not an admin user.");
        return;
      }
      await reply(formatAdminHelp());
      return;
    }

    if (isShowClawsCommand(text)) {
      if (!user) {
        await reply("You're not registered with NemoClaw. Ask an admin to run: `nemoclaw user-add`\nYour Slack ID: `" + event.user + "`");
        return;
      }
      if (!isAdminUser(user)) {
        await reply("You are registered, but you are not an admin user.");
        return;
      }
      await reply(buildShowClawsPayload(text));
      return;
    }

    if (isShowUserCommand(text)) {
      if (!user) {
        await reply("You're not registered with NemoClaw. Ask an admin to run: `nemoclaw user-add`\nYour Slack ID: `" + event.user + "`");
        return;
      }
      if (!isAdminUser(user)) {
        await reply("You are registered, but you are not an admin user.");
        return;
      }
      await reply(buildShowUserPayload(text));
      return;
    }

    if (isAddClawCommand(text) || isDeleteClawCommand(text) || isConfirmDeleteClawCommand(text)) {
      if (!isDM) {
        await reply("Admin claw management commands must be sent as a direct message.");
        return;
      }
      if (!user) {
        await reply("You're not registered with NemoClaw. Ask an admin to run: `nemoclaw user-add`\nYour Slack ID: `" + event.user + "`");
        return;
      }
      if (!isAdminUser(user)) {
        await reply("You are registered, but you are not an admin user.");
        return;
      }

      const thinkingMsg = await app.client.chat.postMessage({
        token: SLACK_BOT_TOKEN,
        channel,
        thread_ts: threadTs,
        text: "Running admin command...",
      });

      const result = isAddClawCommand(text)
        ? await handleAddClaw(user, text)
        : isDeleteClawCommand(text)
          ? await handleDeleteClaw(user, text)
          : await handleConfirmDeleteClaw(user, text);

      await app.client.chat.update({
        token: SLACK_BOT_TOKEN,
        channel,
        ts: thinkingMsg.ts,
        text: result.message,
      });
      return;
    }

    // ── !setup commands (self-service onboarding) ──────────────
    if (isSetupCommand(text)) {
      // !setup help is available to everyone (normalize for mobile keyboard artifacts)
      const normalized = normalizeText(text).toLowerCase();
      if (normalized === "!setup help" || normalized === "!setup") {
        await reply(setupHelp());
        return;
      }

      // All other !setup commands require DM and registration
      if (!isDM) {
        await reply("For security, `!setup` commands with credentials must be sent as a *direct message* to me, not in a channel.");
        return;
      }

      if (!user) {
        await reply("You're not registered yet. Ask an admin to run `nemoclaw user-add` with your Slack user ID first.\nYour Slack ID: `" + event.user + "`");
        return;
      }

      const setupText = normalizeText(text).slice("!setup ".length);
      const displayName = user.slackDisplayName || event.user;
      console.log(`[setup] ${displayName}: !setup ${setupText.slice(0, 30)}...`);

      const { response, deleteMessage } = handleSetup(user, setupText);

      // Delete the user's message containing credentials
      if (deleteMessage) {
        try {
          await app.client.chat.delete({
            token: SLACK_BOT_TOKEN,
            channel,
            ts: event.ts,
          });
          console.log(`[setup] Deleted credential message from ${displayName}`);
        } catch (delErr) {
          // Bot may not have permission to delete user messages in DMs
          // That's OK — we still process the command
          console.log(`[setup] Could not delete message (${delErr.message}) — proceeding`);
        }
      }

      await reply(response);
      return;
    }

    // ── Normal message routing ─────────────────────────────────
    // Only respond to 1:1 DMs — never respond to @mentions in channels or group chats
    if (!isDM) {
      console.log(`[ignored] non-DM message from ${event.user} in channel ${channel} — bot only responds in 1:1 DMs`);
      return;
    }

    if (!user) {
      // User directly DMed the bot — tell them how to register
      console.log(`[unregistered] user ${event.user} DMed bot`);
      await reply("You're not registered with NemoClaw. Ask an admin to run: `nemoclaw user-add`\nYour Slack ID: `" + event.user + "`\n\nOnce registered, DM me `!setup help` to configure your credentials.");
      return;
    }

    const displayName = user.slackDisplayName || event.user;
    console.log(`[${channel}] ${displayName} → ${user.sandboxName}: ${text}`);

    try {
      const thinkingMsg = await app.client.chat.postMessage({
        token: SLACK_BOT_TOKEN,
        channel,
        thread_ts: threadTs,
        text: "Working on it...",
      });

      let response = await runAgentInSandbox(text, `${event.user}-${channel}-${Date.now()}`, user);
      console.log(`[${channel}] ${user.sandboxName} → ${displayName}: ${response.slice(0, 100)}...`);

      // On auth error: refresh credentials and retry once before giving up
      if (AUTH_ERROR_RE.test(response)) {
        console.log(`[${channel}] Auth error detected for ${user.sandboxName}, refreshing credentials and retrying...`);
        await app.client.chat.update({
          token: SLACK_BOT_TOKEN,
          channel,
          ts: thinkingMsg.ts,
          text: "Refreshing credentials, one moment...",
        });
        if (refreshCredentials(user.sandboxName, user.credentialsDir || "")) {
          response = await runAgentInSandbox(text, `${event.user}-${channel}-${Date.now()}-retry`, user);
          console.log(`[${channel}] ${user.sandboxName} → ${displayName} (retry): ${response.slice(0, 100)}...`);
        }
      }

      // Redact credential/auth errors in public channels — only show details in DMs
      const isAuthError = AUTH_ERROR_RE.test(response);
      if (isAuthError && !isDM) {
        console.error(`[${channel}] suppressing auth error in public channel for ${displayName}`);
        response = "I'm having a temporary issue — please try again in a few minutes or DM me directly.";
      }

      await app.client.chat.update({
        token: SLACK_BOT_TOKEN,
        channel,
        ts: thinkingMsg.ts,
        text: response,
      });
    } catch (err) {
      console.error(`[${channel}] error for ${displayName}:`, err.message);
      // Redact auth errors in public channels
      const errMsg = err.message || "";
      const isAuthErr = /authentication_error|invalid_grant|Invalid authentication|401.*auth/i.test(errMsg);
      const safeMsg = (!isDM && isAuthErr)
        ? "I'm having a temporary issue — please try again in a few minutes or DM me directly."
        : `Error: ${errMsg}`;
      await say({ text: safeMsg, thread_ts: threadTs });
    }
  }

  await app.start();

  const userCount = Object.keys(userMap).length;
  const sandboxList = Object.values(userMap).map((u) => `${u.slackDisplayName} → ${u.sandboxName}`);

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Multi-User Slack Bridge                   │");
  console.log("  │                                                     │");
  console.log("  │  Users: " + (String(userCount) + " registered                            ").slice(0, 43) + "│");
  for (const line of sandboxList) {
    console.log("  │    " + (line + "                                              ").slice(0, 49) + "│");
  }
  console.log("  │                                                     │");
  console.log("  │  Messages are routed by Slack user ID to the        │");
  console.log("  │  correct sandbox. Run 'openshell term' to monitor.  │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");
}

if (require.main === module) {
  main();
}

module.exports = {
  parseCommandArgs,
  isAdminUser,
  isListAdminsCommand,
  isAdminAuditCommand,
  isShowClawsCommand,
  isShowUserCommand,
  isAdminHelpCommand,
  isAddClawCommand,
  isDeleteClawCommand,
  isConfirmDeleteClawCommand,
  parseSandboxList,
  formatDurationFrom,
  getInventoryStatus,
  listConfiguredCredentials,
  buildClawInventory,
  parseShowClawsOptions,
  filterAndSortClawInventory,
  formatClawInventory,
  buildShowClawsPayload,
  buildShowClawsTablePayload,
  buildShowClawsTablePayloadFromInventory,
  resolveUserLookup,
  buildShowUserText,
  buildShowUserPayload,
  buildAdminUserList,
  formatAdminUsersFromList,
  formatRecentAdminAudit,
  readRecentAdminAudit,
  withAdminState,
  formatAdminHelp,
  getClaudeCredentialSource,
  describeClaudeCredentialSource,
};
