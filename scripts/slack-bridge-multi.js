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
const { getProviderSelectionConfig } = require("../bin/lib/inference-config");

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
const RATE_LIMIT_RE = /rate.limit|429|too many requests|overloaded|capacity/i;
const ADMIN_AUDIT_LOG = `${REPO_DIR}/persist/audit/admin-actions.log`;
const DEFAULT_STARTUP_STALL_MS = 180000;
const STARTUP_STALL_MS = Number.parseInt(process.env.NEMOCLAW_STARTUP_STALL_MS || "", 10) || DEFAULT_STARTUP_STALL_MS;
const pendingDeleteRequests = new Map();
const lastEmailRequests = new Map();
const lastUserRequests = new Map();

// ── Global rate limit throttle ───────────────────────────────────
// When a rate limit is detected, pause all new agent launches for a cooldown.
let rateLimitCooldownUntil = 0;
const RATE_LIMIT_COOLDOWN_MS = 60000; // 1 minute cooldown after rate limit

function isRateLimited() {
  return Date.now() < rateLimitCooldownUntil;
}

function triggerRateLimitCooldown() {
  rateLimitCooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  console.log(`[rate-limit] Cooldown active for ${RATE_LIMIT_COOLDOWN_MS / 1000}s (until ${new Date(rateLimitCooldownUntil).toISOString()})`);
}

async function waitForRateLimitCooldown() {
  if (!isRateLimited()) return;
  const waitMs = rateLimitCooldownUntil - Date.now();
  console.log(`[rate-limit] Waiting ${Math.round(waitMs / 1000)}s for cooldown...`);
  await new Promise((r) => setTimeout(r, waitMs));
}

// ── Per-user message queue (serializes agent runs per sandbox) ────
// OpenClaw's lane-level session lock only allows one concurrent agent run.
// Without queuing, a second message while the first is still running hits
// "session file locked" and the agent exits with code 1.
const userQueues = new Map(); // sandboxName → Promise chain

function enqueueForUser(sandboxName, fn) {
  const prev = userQueues.get(sandboxName) || Promise.resolve();
  const next = prev.then(fn, fn); // run fn after prev settles (success or fail)
  userQueues.set(sandboxName, next);
  return next;
}

function sh(value) {
  return String(value).replace(/'/g, "'\\''");
}
const DELETE_CONFIRM_TTL_MS = 5 * 60 * 1000;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_GITHUB_HANDLE_LENGTH = 39;

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

function canonicalizeAdminCommand(text) {
  return normalizeText(text)
    .replace(/^!show\s+claws\b/i, "!show-claws")
    .replace(/^!list\s+claws\b/i, "!list-claws")
    .replace(/^!show\s+user\b/i, "!show-user")
    .replace(/^!admin\s+audit\b/i, "!admin-audit")
    .replace(/^!admin\s+help\b/i, "!admin-help")
    .replace(/^!help\s+admin\b/i, "!help-admin")
    .replace(/^!add\s+claw\b/i, "!add-claw")
    .replace(/^!purge\s+claw\b/i, "!purge-claw")
    .replace(/^!delete\s+claw\b/i, "!delete-claw")
    .replace(/^!confirm(?:-|\s+)delete(?:-|\s+)claw\b/i, "!confirm-delete-claw");
}

function looksLikeAdminCommand(text) {
  return /^!(show|list|admin|help|add|delete|confirm|purge)\b/i.test(canonicalizeAdminCommand(text).trim());
}

function isListAdminsCommand(text) {
  const normalized = canonicalizeAdminCommand(text).toLowerCase();
  return normalized === "!admins" || normalized === "!admins list" || normalized === "!admin-users";
}

function isAdminAuditCommand(text) {
  const normalized = canonicalizeAdminCommand(text).toLowerCase();
  return normalized === "!admin-audit" || normalized === "!admin-audit 10" || normalized === "!admin-log";
}

function isShowClawsCommand(text) {
  const normalized = canonicalizeAdminCommand(text).toLowerCase();
  return normalized.startsWith("!show-claws") || normalized === "!claws" || normalized.startsWith("!list-claws");
}

function isShowUserCommand(text) {
  const normalized = canonicalizeAdminCommand(text).toLowerCase();
  return normalized.startsWith("!show-user");
}

function isAdminHelpCommand(text) {
  const normalized = canonicalizeAdminCommand(text).toLowerCase();
  return normalized === "!admin-help" || normalized === "!help-admin";
}

function isPurgeClawCommand(text) {
  return canonicalizeAdminCommand(text).toLowerCase().startsWith("!purge-claw");
}

function isKnownBangCommand(text) {
  const normalized = normalizeText(text);
  if (!normalized.startsWith("!")) return false;
  return isListAdminsCommand(text)
    || isAdminAuditCommand(text)
    || isShowClawsCommand(text)
    || isShowUserCommand(text)
    || isAdminHelpCommand(text)
    || isAddClawCommand(text)
    || isPurgeClawCommand(text)
    || isDeleteClawCommand(text)
    || isConfirmDeleteClawCommand(text)
    || isSetupCommand(text)
    || /^!whatsapp\b|^!wa\b/i.test(normalized)
    || /^!yahoo\b/i.test(normalized);
}

function hasYahooCredentials(user) {
  if (!user) return false;
  const credentialsDir = path.resolve(REPO_DIR, user.credentialsDir || `persist/users/${user.slackUserId}/credentials`);
  return fs.existsSync(path.join(credentialsDir, "yahoo-creds.env"));
}

function getUserEnvVars(user) {
  const envPath = path.join(REPO_DIR, "persist", "users", user.slackUserId, ".env");
  const values = {};
  if (!fs.existsSync(envPath)) return values;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    values[key] = value;
  }
  return values;
}

function parseYahooRequest(text) {
  const normalized = normalizeText(text);
  const lower = normalized.toLowerCase();
  if (!/\b(yahoo|email|emails|mail|inbox)\b/i.test(normalized)) return null;
  if (/\b(gmail|google|calendar|meeting|event|events|task|tasks|freshrelease|whatsapp)\b/i.test(lower)) return null;
  const limitMatch = lower.match(/\b(?:top|last|latest|recent|show|list|get)?\s*(\d+)\b/);
  const count = limitMatch ? Math.max(1, Math.min(Number.parseInt(limitMatch[1], 10) || 10, 25)) : 10;
  const unread = /\b(unread|pending)\b/.test(lower);
  const topicMatch = /\bunread\b/.test(lower)
    ? null
    : (lower.match(/\b(?:show|list|get|find|search|check|pull)\s+(.+?)\s+emails?\b/i)
      || lower.match(/\b(.+?)\s+emails?\s+from\s+this year\b/i));
  const fromMatch = lower.match(/\b(?:emails?|mail)\s+from\s+(.+?)(?:\s+about\b|$)/i)
    || lower.match(/\bfrom\s+(.+?)(?:\s+emails?\b|\s+mail\b|\s+about\b|$)/i);
  const aboutMatch = lower.match(/\babout\s+(.+?)$/i)
    || lower.match(/\bregarding\s+(.+?)$/i);
  const queryParts = [];
  if (topicMatch?.[1]) queryParts.push(topicMatch[1].trim());
  if (fromMatch?.[1]) queryParts.push(fromMatch[1].trim());
  if (aboutMatch?.[1]) queryParts.push(aboutMatch[1].trim());
  let year = null;
  if (/\bthis year\b/.test(lower)) year = new Date().getFullYear();
  const explicitYear = lower.match(/\b(20\d{2})\b/);
  if (explicitYear) year = Number.parseInt(explicitYear[1], 10);
  const cleanedQueryParts = queryParts
    .map((part) => part.replace(/\bthis year\b/g, "").replace(/\b20\d{2}\b/g, "").trim())
    .filter(Boolean);
  if ((/\b(search|find|look for|pull|check|show|get|list)\b/.test(lower) || /\bfrom\b/.test(lower)) && cleanedQueryParts.length > 0) {
    return { kind: "search", query: cleanedQueryParts.join(" "), count, year };
  }
  if (/\b(email|emails|mail|inbox)\b/.test(lower)) {
    return { kind: "inbox", count, unread, year };
  }
  return null;
}

function extractMailRefinement(text) {
  const lower = normalizeText(text).toLowerCase();
  let year = null;
  if (/\bthis year\b/.test(lower)) year = new Date().getFullYear();
  const explicitYear = lower.match(/\b(20\d{2})\b/);
  if (explicitYear) year = Number.parseInt(explicitYear[1], 10);
  if (year !== null) return { year };
  return null;
}

function hasGoogleCredentials(user) {
  if (!user) return false;
  const credentialsDir = path.resolve(REPO_DIR, user.credentialsDir || `persist/users/${user.slackUserId}/credentials`);
  return fs.existsSync(path.join(credentialsDir, "gogcli", "config.json"));
}

function loadYahooCreds(user) {
  const yahooCredsPath = `${REPO_DIR}/persist/users/${user.slackUserId}/credentials/yahoo-creds.env`;
  if (!fs.existsSync(yahooCredsPath)) {
    throw new Error("No Yahoo credentials configured. Ask an admin to set up `persist/users/<id>/credentials/yahoo-creds.env` with YAHOO_EMAIL and YAHOO_APP_PWD.");
  }
  const yahooCreds = {};
  fs.readFileSync(yahooCredsPath, "utf-8").split("\n").forEach((line) => {
    const [k, ...v] = line.split("=");
    if (k && v.length) yahooCreds[k.trim()] = v.join("=").trim();
  });
  return yahooCreds;
}

function runYahooHelper(user, args = []) {
  return execFileSync("python3", [`${REPO_DIR}/scripts/yahoo-mail.py`, ...args], {
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, ...loadYahooCreds(user) },
  }).trim();
}

function runEmailHelper(user, request) {
  const args = request.kind === "search"
    ? ["--query", request.query, "--count", String(request.count), ...(request.year ? ["--year", String(request.year)] : [])]
    : ["--inbox", "--count", String(request.count), ...(request.unread ? ["--unread"] : []), ...(request.year ? ["--year", String(request.year)] : [])];
  return execFileSync("python3", [`${REPO_DIR}/scripts/email-query.py`, ...args], {
    cwd: REPO_DIR,
    encoding: "utf-8",
    timeout: 45000,
    env: {
      ...process.env,
      ...(hasYahooCredentials(user) ? loadYahooCreds(user) : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function redactSensitiveText(text, user) {
  let redacted = String(text || "");
  redacted = redacted.replace(/(sk-ant-[A-Za-z0-9_-]+)/g, "[REDACTED]");
  return redacted;
}

function buildFriendlyFailure(kind, detail = "") {
  const raw = String(detail || "");
  const normalized = raw.toLowerCase();
  if (AUTH_ERROR_RE.test(raw)) {
    return "I'm having a temporary authentication issue. Please try again in a few minutes.";
  }
  if (/timeout|timed out/.test(normalized)) {
    return `I couldn't complete that ${kind} request before timing out. Please try again.`;
  }
  if (/unknown command/.test(normalized)) {
    return "Unknown command.";
  }
  if (kind === "Email") {
    return "I couldn't fetch email for that request. Try rephrasing it with who or what you're looking for.";
  }
  if (/sandbox|agent exited|setting up nemoclaw|cap_setpcap|traceback|cannot reach sandbox|error launching/.test(normalized)) {
    return "I couldn't complete that request in the sandbox. Please try again.";
  }
  return `I couldn't complete that ${kind.toLowerCase()} request. Please try again.`;
}

function sanitizeUserFacingResponse(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (/Agent exited with code/i.test(raw)
    || /Setting up NemoClaw/i.test(raw)
    || /\[SECURITY\]/i.test(raw)
    || /CAP_SETPCAP/i.test(raw)
    || /^Traceback /m.test(raw)
    || /Cannot reach sandbox/i.test(raw)
    || /sandbox '.*' unreachable/i.test(raw)
    || /Error launching/i.test(raw)) {
    return buildFriendlyFailure("sandbox", raw);
  }
  return raw;
}

function isRetryCommand(text) {
  const normalized = normalizeText(text).trim().toLowerCase();
  return normalized === "retry"
    || normalized === "try again"
    || normalized === "retry that"
    || /^retry my last\b/.test(normalized)
    || /^retry last\b/.test(normalized);
}

function recordEmailRequest(slackUserId, request) {
  if (!slackUserId || !request) return;
  lastEmailRequests.set(slackUserId, request);
}

function getRecordedEmailRequest(slackUserId) {
  return lastEmailRequests.get(slackUserId) || null;
}

function recordLastUserRequest(slackUserId, text) {
  if (!slackUserId || !text || isRetryCommand(text)) return;
  lastUserRequests.set(slackUserId, text);
}

function getRecordedLastUserRequest(slackUserId) {
  return lastUserRequests.get(slackUserId) || "";
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
  return canonicalizeAdminCommand(text).toLowerCase().startsWith("!add-claw");
}

function isDeleteClawCommand(text) {
  return canonicalizeAdminCommand(text).toLowerCase().startsWith("!delete-claw");
}

function isConfirmDeleteClawCommand(text) {
  return canonicalizeAdminCommand(text).toLowerCase().startsWith("!confirm-delete-claw");
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
    "`!purge-claw <claw_name>`",
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
  const tokenPath = path.join(credDir, "claude-oauth-token.txt");
  if (fs.existsSync(tokenPath)) {
    return { mode: "long-lived-token", path: tokenPath };
  }
  const perUserPath = path.join(credDir, "claude-credentials.json");
  if (fs.existsSync(perUserPath)) {
    return { mode: "per-user", path: perUserPath };
  }
  return { mode: "missing", path: "" };
}

function describeClaudeCredentialSource(user) {
  const source = getClaudeCredentialSource(user);
  if (source.mode === "long-lived-token") return "per-user long-lived token";
  if (source.mode === "per-user") return "per-user";
  return "not configured";
}

function buildAuthRecoveryMessage(user) {
  const source = getClaudeCredentialSource(user);
  if (source.mode === "per-user") {
    return [
      "Anthropic authentication is still failing after retry.",
      "Your sandbox is using per-user Claude OAuth credentials, and those tokens are not auto-refreshed by the bridge.",
      "Run `claude` on your machine to refresh the login, then `!setup claude <fresh ~/.claude/.credentials.json>`. Or switch to `!setup claude-token` for a more durable auth method.",
    ].join("\n");
  }
  if (source.mode === "long-lived-token") {
    return [
      "Anthropic authentication is still failing after retry.",
      "Your sandbox is using a per-user Claude long-lived token from `claude setup-token`.",
      "Re-run `claude setup-token` on your machine and DM the new token with `!setup claude-token <token>`.",
    ].join("\n");
  }
  return [
    "Anthropic authentication is not configured for this sandbox.",
    "Run `!setup claude-token <token>` from `claude setup-token`, or `!setup claude <fresh ~/.claude/.credentials.json>`.",
  ].join("\n");
}

function requestLikelyNeedsMcp(text) {
  return /\bfreshrelease\b|\bmcp\b|\bepic\b|\bissue\b|\bstory\b|\bticket\b|\btask\b|\bsprint\b|\bbacklog\b|\bboard\b|\bassigned\b|\bcalendar\b|\bevent\b|\bmeeting\b|\bgmail\b|\bemail\b|\binbox\b|\bgoogle\b|\bdocs\b|\bdrive\b/i.test(String(text || ""));
}

function listConfiguredCredentials(user) {
  if (!user?.credentialsDir) return [];
  const credDir = path.isAbsolute(user.credentialsDir)
    ? user.credentialsDir
    : path.join(REPO_DIR, user.credentialsDir);
  const configured = [];
  const checks = [
    ["Claude Teams token", path.join(credDir, "claude-oauth-token.txt")],
    ["Claude OAuth", path.join(credDir, "claude-credentials.json")],
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
  const args = parseCommandArgs(canonicalizeAdminCommand(text)).slice(1);
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
    `Credentials: ${credentials.length ? credentials.join(", ") : "none"}`,
    `Policies: ${policies.length ? policies.join(", ") : "none"}`,
  ].join("\n");
}

function buildShowUserPayload(text) {
  const args = parseCommandArgs(canonicalizeAdminCommand(text)).slice(1);
  return { text: buildShowUserText(resolveUserLookup(args.join(" "))) };
}

function formatAddClawUsage() {
  return "Usage: `!add-claw <slack_id> <display_name> <claw_name> <github_handle>`\nExample: `!add-claw U12345ABC \"Jane Doe\" jane-claw janedoe`";
}

function buildAddClawSuccessMessage({ slackId, displayName, clawName, githubHandle, userAddOutput = "", resilienceOutput = "", statusSummary = "", warningOutput = "" }) {
  const sections = [
    `Created claw \`${clawName}\` for ${displayName} (\`${slackId}\`).`,
    `GitHub: \`${githubHandle}\``,
  ];
  if (userAddOutput.trim()) {
    sections.push("", "*user-add output*", "```", userAddOutput.trim().slice(-2500), "```");
  }
  if (resilienceOutput.trim()) {
    sections.push("", "*resilience output*", "```", resilienceOutput.trim().slice(-2500), "```");
  }
  if (statusSummary.trim()) {
    sections.push("", "*verification*", "```", statusSummary, "```");
  }
  if (warningOutput.trim()) {
    sections.push("", "*warning*", "```", warningOutput.trim().slice(-2500), "```");
  }
  sections.push("", `Claude auth source: ${describeClaudeCredentialSource(userRegistry.getUser(slackId) || { credentialsDir: `persist/users/${slackId}/credentials` })}`);
  return sections.join("\n");
}

async function handleAddClaw(user, text) {
  const args = parseCommandArgs(canonicalizeAdminCommand(text)).slice(1);
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
      message: buildAddClawSuccessMessage({ slackId, displayName, clawName, githubHandle, userAddOutput, resilienceOutput, statusSummary }),
    };
  } catch (err) {
    const output = `${err.stdout || ""}${err.stderr || ""}`.trim() || err.message;
    const createdUser = userRegistry.getUser(slackId);
    const liveSandbox = loadLiveSandboxMap().get(clawName);
    const sandboxReady = liveSandbox?.phase === "Ready";
    if (createdUser?.sandboxName === clawName && sandboxReady) {
      const statusSummary = getProvisioningSummary(slackId, clawName);
      auditAdminAction(user, "add-claw", { slackId, displayName, clawName, githubHandle }, "succeeded-with-warning", output.slice(0, 1000));
      return {
        ok: true,
        message: buildAddClawSuccessMessage({
          slackId,
          displayName,
          clawName,
          githubHandle,
          statusSummary,
          warningOutput: `Provisioning completed, but an intermediate step returned a noisy error.\n${output}`,
        }),
      };
    }
    auditAdminAction(user, "add-claw", { slackId, displayName, clawName, githubHandle }, "failed", output.slice(0, 1000));
    return {
      ok: false,
      message: `Failed to create claw \`${clawName}\`.\n\`\`\`\n${output.slice(-3500)}\n\`\`\``,
    };
  }
}

async function handleDeleteClaw(user, text) {
  const args = parseCommandArgs(canonicalizeAdminCommand(text)).slice(1);
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
  const args = parseCommandArgs(canonicalizeAdminCommand(text)).slice(1);
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

async function handlePurgeClaw(user, text) {
  const args = parseCommandArgs(canonicalizeAdminCommand(text)).slice(1);
  if (args.length !== 1) {
    return {
      ok: false,
      message: "Usage: `!purge-claw <claw_name>`\nExample: `!purge-claw alice-claw`",
    };
  }

  const clawName = args[0];
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(clawName)) {
    return { ok: false, message: `Invalid claw name: \`${clawName}\`.` };
  }

  auditAdminAction(user, "purge-claw", { clawName }, "started");

  try {
    const purgeOutput = runAdminCommand(process.execPath, [
      "bin/nemoclaw.js",
      "user-purge",
      "--sandbox",
      clawName,
    ], 600000);
    auditAdminAction(user, "purge-claw", { clawName }, "succeeded");
    return {
      ok: true,
      message: [
        `Purged claw \`${clawName}\`.`,
        "",
        "```",
        purgeOutput.trim().slice(-3000) || "(no output)",
        "```",
      ].join("\n"),
    };
  } catch (err) {
    const output = `${err.stdout || ""}${err.stderr || ""}`.trim() || err.message;
    auditAdminAction(user, "purge-claw", { clawName }, "failed", output.slice(0, 1000));
    return {
      ok: false,
      message: `Failed to purge claw \`${clawName}\`.\n\`\`\`\n${output.slice(-3500)}\n\`\`\``,
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

function getRuntimeFallbackModels(sandboxName) {
  const script = Buffer.from(
    `import json, os\n` +
    `path=os.path.expanduser('~/.openclaw/openclaw.json')\n` +
    `try:\n    cfg=json.load(open(path))\nexcept Exception:\n    print('{}')\n    raise SystemExit(0)\n` +
    `providers=((cfg.get('models') or {}).get('providers') or {})\n` +
    `out={}\n` +
    `for name in ('nvidia','ollama','inference'):\n` +
    `    val=providers.get(name)\n` +
    `    if isinstance(val, dict):\n` +
    `        models=val.get('models') or []\n` +
    `        mids=[m.get('id') for m in models if isinstance(m, dict) and m.get('id')]\n` +
    `        if mids:\n            out[name]=mids\n` +
    `print(json.dumps(out))\n`
  ).toString("base64");

  try {
    const sshConfig = execSync(`"${OPENSHELL}" sandbox ssh-config "${sandboxName}"`, { encoding: "utf-8" });
    const confPath = `/tmp/nemoclaw-fallback-${sandboxName}.conf`;
    fs.writeFileSync(confPath, sshConfig);
    try {
      const raw = execFileSync("ssh", [
        "-T", "-F", confPath, `openshell-${sandboxName}`,
        `echo '${script}' | base64 -d | python3`,
      ], {
        encoding: "utf-8",
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const parsed = JSON.parse(raw.trim() || "{}");
      return {
        nvidia: parsed.nvidia?.[0] || null,
        ollama: parsed.ollama?.[0] || null,
      };
    } finally {
      try { fs.unlinkSync(confPath); } catch {}
    }
  } catch {
    return { nvidia: null, ollama: null };
  }
}

function buildAgentCommand(message, sessionId, user, options = {}) {
  const executionGuardrails = [
    "Slack execution rules:",
    "- Do not start background Claude Code sessions or detached jobs for user requests.",
    "- Do not say work is running in the background.",
    "- If you use Claude Code or any coding tool, keep it in the foreground and wait for completion.",
    "- Only report success after the requested work, tests, and PR creation are actually complete.",
    "- If blocked, report the concrete blocker instead of claiming ongoing background progress.",
    "",
    `User request: ${message}`,
  ].join("\n");
  const escaped = executionGuardrails.replace(/'/g, "'\\''");
  const setupLines = [
    `export NVIDIA_API_KEY='${sh(API_KEY)}'`,
    `export OPENAI_API_KEY='${sh(API_KEY)}'`,
    "export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache",
    "export OPENCLAW_NO_RESPAWN=1",
    `export NEMOCLAW_SLACK_USER_ID='${sh(user.slackUserId)}'`,
    `export NEMOCLAW_SLACK_DISPLAY_NAME='${sh(user.slackDisplayName || user.slackUserId)}'`,
    `export NEMOCLAW_USER_ROLES='${sh((user.roles || ["user"]).join(","))}'`,
    `export NEMOCLAW_IS_ADMIN='${(user.roles || []).includes("admin") ? "1" : "0"}'`,
    "source /sandbox/.bashrc 2>/dev/null",
  ];
  if (options.skipClaudeAuth) {
    setupLines.push("unset ANTHROPIC_API_KEY");
    setupLines.push("export NEMOCLAW_SKIP_CLAUDE_AUTH=1");
  }
  const scriptLines = [...setupLines];
  // Clean stale session locks before running (zombie openclaw-agent processes leave orphan locks)
  scriptLines.push(`find /sandbox/.openclaw/agents -name '*.lock' -mmin +2 -delete 2>/dev/null || true`);
  scriptLines.push(`NEMOCLAW_START_BIN=/usr/local/bin/nemoclaw-start; [ -x /sandbox/bin/nemoclaw-start ] && NEMOCLAW_START_BIN=/sandbox/bin/nemoclaw-start`);
  scriptLines.push(`"$NEMOCLAW_START_BIN" openclaw agent --agent main --local -m '${escaped}' --session-id 'slack-${sessionId}'`);
  return scriptLines.join("\n");
}

function syncSandboxSelectionConfig(user, provider, model) {
  const selectionConfig = getProviderSelectionConfig(provider, model);
  if (!selectionConfig) return;
  const sandboxName = user.sandboxName;
  const cfgPayload = Buffer.from(JSON.stringify({ ...selectionConfig, onboardedAt: new Date().toISOString() })).toString("base64");
  const script = Buffer.from(
    `import json, os\n` +
    `import base64\n` +
    `path = os.path.expanduser('~/.nemoclaw/config.json')\n` +
    `os.makedirs(os.path.dirname(path), exist_ok=True)\n` +
    `cfg = json.loads(base64.b64decode(${JSON.stringify(cfgPayload)}).decode())\n` +
    `json.dump(cfg, open(path, 'w'), indent=2)\n`
  ).toString("base64");

  let sshConfig;
  try {
    sshConfig = execSync(`"${OPENSHELL}" sandbox ssh-config "${sandboxName}"`, { encoding: "utf-8" });
  } catch {
    return;
  }
  const confPath = `/tmp/nemoclaw-sync-${sandboxName}-${process.pid}-${Date.now()}.conf`;
  fs.writeFileSync(confPath, sshConfig);
  try {
    execFileSync("ssh", ["-T", "-F", confPath, `openshell-${sandboxName}`, `echo '${script}' | base64 -d | python3`], {
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    try { fs.unlinkSync(confPath); } catch {}
  }
}

const _primaryModelCache = new Map();

function getSandboxPrimaryModel(sandboxName) {
  const script = Buffer.from(
    `import json, os\n` +
    `path = os.path.expanduser('~/.openclaw/openclaw.json')\n` +
    `try:\n    cfg = json.load(open(path))\nexcept: exit(0)\n` +
    `print(cfg.get('agents',{}).get('defaults',{}).get('model',{}).get('primary',''))\n`
  ).toString("base64");

  let sshConfig;
  try {
    sshConfig = execSync(`"${OPENSHELL}" sandbox ssh-config "${sandboxName}"`, { encoding: "utf-8" });
  } catch { return null; }
  const confPath = `/tmp/nemoclaw-getmodel-${sandboxName}-${process.pid}.conf`;
  fs.writeFileSync(confPath, sshConfig);
  try {
    const result = execFileSync("ssh", ["-T", "-F", confPath, `openshell-${sandboxName}`, `echo '${script}' | base64 -d | python3`], {
      encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return result || null;
  } catch { return null; }
  finally { try { fs.unlinkSync(confPath); } catch {} }
}

function setSandboxPrimaryModel(user, primaryModelRef) {
  const sandboxName = user.sandboxName;
  if (_primaryModelCache.get(sandboxName) === primaryModelRef) return;

  const script = Buffer.from(
    `import json, os, sys\n` +
    `path = os.path.expanduser('~/.openclaw/openclaw.json')\n` +
    `if not os.access(path, os.W_OK):\n` +
    `    print('skip: not writable', file=sys.stderr)\n` +
    `    sys.exit(0)\n` +
    `cfg = json.load(open(path))\n` +
    `cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = ${JSON.stringify(primaryModelRef)}\n` +
    `json.dump(cfg, open(path, 'w'), indent=2)\n` +
    `os.chmod(path, 0o600)\n`
  ).toString("base64");

  let sshConfig;
  try {
    sshConfig = execSync(`"${OPENSHELL}" sandbox ssh-config "${sandboxName}"`, { encoding: "utf-8" });
  } catch {
    return;
  }
  const confPath = `/tmp/nemoclaw-primary-${sandboxName}-${process.pid}-${Date.now()}.conf`;
  fs.writeFileSync(confPath, sshConfig);
  try {
    execFileSync("ssh", ["-T", "-F", confPath, `openshell-${sandboxName}`, `echo '${script}' | base64 -d | python3`], {
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    _primaryModelCache.set(sandboxName, primaryModelRef);
  } finally {
    try { fs.unlinkSync(confPath); } catch {}
  }
}

function selectInferenceRoute(user, provider, model) {
  execFileSync(OPENSHELL, ["gateway", "select", "nemoclaw"], {
    encoding: "utf-8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const env = { ...process.env };
  if (provider === "nvidia-nim") {
    env.OPENAI_API_KEY = API_KEY;
  } else if (provider === "ollama-local") {
    env.OPENAI_API_KEY = "ollama";
  }
  execFileSync(OPENSHELL, ["inference", "set", "--no-verify", "--provider", provider, "--model", model], {
    encoding: "utf-8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  syncSandboxSelectionConfig(user, provider, model);
  if (provider === "nvidia-nim") {
    setSandboxPrimaryModel(user, `nvidia/${model}`);
  } else if (provider === "ollama-local") {
    setSandboxPrimaryModel(user, `ollama/${model}`);
  } else if (provider === "anthropic-prod") {
    setSandboxPrimaryModel(user, `anthropic/${model}`);
  }
}

// ── Fallback routing on auth failure or rate limit ────────────────

// Fallback chain: NVIDIA Nemotron → Ollama (deepseek-r1 → qwen3-coder → gpt-oss)
const OLLAMA_FALLBACK_MODELS = ["deepseek-r1:70b", "qwen3-coder:30b", "gpt-oss:latest"];

async function attemptFallbackRouting(user, text, baseSessionId, channel, displayName) {
  const fallbackModels = getRuntimeFallbackModels(user.sandboxName);
  console.log(`[${channel}] fallback models for ${user.sandboxName}:`, fallbackModels);

  const isUsable = (resp) => resp && !AUTH_ERROR_RE.test(resp) && !RATE_LIMIT_RE.test(resp) && !/Unknown model:/i.test(resp) && !/no response/i.test(resp);

  try {
    // 1. Try NVIDIA Nemotron
    if (fallbackModels.nvidia) {
      console.log(`[${channel}] trying NVIDIA fallback: ${fallbackModels.nvidia}`);
      selectInferenceRoute(user, "nvidia-nim", fallbackModels.nvidia);
      const nvidiaResponse = await runAgentInSandbox(text, `${baseSessionId}-nvidia`, user, { skipClaudeAuth: true });
      console.log(`[${channel}] ${user.sandboxName} → ${displayName} (nvidia): ${nvidiaResponse.slice(0, 100)}...`);
      if (isUsable(nvidiaResponse)) {
        return `[fallback: NVIDIA Nemotron]\n${nvidiaResponse}`;
      }
    }

    // 2. Try Ollama models in preference order: kimi-k2 → deepseek-r1 → gpt-oss
    if (fallbackModels.ollama) {
      for (const model of OLLAMA_FALLBACK_MODELS) {
        console.log(`[${channel}] trying Ollama fallback: ${model}`);
        selectInferenceRoute(user, "ollama-local", model);
        const ollamaResponse = await runAgentInSandbox(text, `${baseSessionId}-ollama-${model.replace(/[^a-z0-9]/g, "")}`, user, { skipClaudeAuth: true });
        console.log(`[${channel}] ${user.sandboxName} → ${displayName} (ollama/${model}): ${ollamaResponse.slice(0, 100)}...`);
        if (isUsable(ollamaResponse)) {
          return `[fallback: Ollama ${model}]\n${ollamaResponse}`;
        }
      }
    }

    return "All inference providers are unavailable (Anthropic rate-limited, NVIDIA and Ollama fallbacks failed). Please try again in a few minutes.";
  } catch (fallbackErr) {
    return `Fallback routing failed: ${fallbackErr.message}`;
  } finally {
    // Restore the sandbox's configured primary model (may be Ollama or Anthropic)
    try {
      const sandboxPrimary = getSandboxPrimaryModel(user.sandboxName);
      if (sandboxPrimary) {
        setSandboxPrimaryModel(user, sandboxPrimary);
      }
    } catch (restoreErr) {
      console.error(`[${channel}] failed to restore primary model for ${user.sandboxName}: ${restoreErr.message}`);
    }
  }
}

// ── WhatsApp forwarding for notifications ────────────────────────
// Forwards notification-like messages (heartbeat alerts, reminders) to WhatsApp.
// Only triggers for messages with notification markers (emoji prefixes).

const WA_NOTIFICATION_RE = /^[📧📅⏰🔔⚠️❗🚨📌📋✅🆘]/u;

function maybeForwardToWhatsApp(user, message) {
  if (!message || !WA_NOTIFICATION_RE.test(message.trim())) return;
  const waNumberFile = `${REPO_DIR}/persist/users/${user.slackUserId}/credentials/whatsapp-number.txt`;
  if (!fs.existsSync(waNumberFile)) return;
  const waNumber = fs.readFileSync(waNumberFile, "utf-8").trim();
  if (!waNumber) return;
  // Strip markdown for WhatsApp
  const plainMsg = message.replace(/\*([^*]+)\*/g, "$1").replace(/<([^|>]+)\|([^>]+)>/g, "$2").trim();
  try {
    execFileSync("node", [`${REPO_DIR}/scripts/whatsapp-bridge.js`, "send", waNumber, plainMsg], {
      encoding: "utf-8",
      timeout: 30000,
      env: { ...process.env, SLACK_USER_ID: user.slackUserId },
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(`[wa] Forwarded notification to ${waNumber} for ${user.slackDisplayName}`);
  } catch (err) {
    console.error(`[wa] Forward failed for ${user.slackDisplayName}: ${(err.message || "").slice(0, 100)}`);
  }
}

// ── Response → Slack table blocks ────────────────────────────────
// Detects markdown tables OR structured numbered/bullet lists in
// agent responses and converts them to Slack native table blocks.

const MD_TABLE_RE = /(?:^|\n)((?:\|[^\n]+\|\s*\n)*\|[^\n]+\|[^\n]*)/g;
const MD_SEPARATOR_RE = /^\|[\s:|-]+\|$/;

function parseMarkdownTable(tableText) {
  const lines = tableText.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  const parseRow = (line) =>
    line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

  const header = parseRow(lines[0]);
  const dataStart = MD_SEPARATOR_RE.test(lines[1]) ? 2 : 1;
  const rows = lines.slice(dataStart).filter((l) => !MD_SEPARATOR_RE.test(l)).map(parseRow);

  if (header.length === 0 || rows.length === 0) return null;
  return { header, rows };
}

// Parse structured numbered lists like:
//   1. **KEY** — Title · Status · Assignee
//   2. **KEY** — Title · Status · Assignee
// Also handles: - **KEY** — ... and bullet variants
function parseStructuredList(response) {
  const lines = response.split("\n").map((l) => l.trim()).filter(Boolean);

  // Find consecutive numbered/bulleted lines with a consistent separator pattern
  // Match: "1. **SOMETHING** — rest" or "- **SOMETHING** — rest"
  const ITEM_RE = /^(?:\d+\.\s+|\*\s+|-\s+)\*{0,2}([A-Z][\w-]*(?:-\d+)?)\*{0,2}\s*[—–-]\s*(.+)$/;
  const items = [];
  let listStart = -1;
  let listEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ITEM_RE);
    if (m) {
      if (listStart === -1) listStart = i;
      listEnd = i;
      items.push({ key: m[1], rest: m[2] });
    } else if (items.length > 0) {
      break; // list ended
    }
  }

  if (items.length < 2) return null;

  // Split the "rest" by · (middle dot), • (bullet), or | (pipe)
  const splitRest = (rest) => rest.split(/\s*[·•|]\s*/).map((s) => s.replace(/\*{1,2}/g, "").trim()).filter(Boolean);

  const parsed = items.map((item) => [item.key, ...splitRest(item.rest)]);
  const maxCols = Math.max(...parsed.map((r) => r.length));
  if (maxCols < 2) return null;

  // Infer column headers from content patterns
  const headers = ["Key"];
  // First non-key column is usually title/name
  if (maxCols >= 2) headers.push("Title");
  if (maxCols >= 3) headers.push("Status");
  if (maxCols >= 4) headers.push("Assignee");
  for (let i = headers.length; i < maxCols; i++) headers.push(`Col ${i + 1}`);

  // Pad rows
  const rows = parsed.map((r) => {
    while (r.length < maxCols) r.push("");
    return r.slice(0, maxCols);
  });

  // Reconstruct which part of the response is the list
  const beforeLines = lines.slice(0, listStart);
  const afterLines = lines.slice(listEnd + 1);

  return { header: headers, rows, before: beforeLines.join("\n").trim(), after: afterLines.join("\n").trim() };
}

// Convert markdown links [text](url) to Slack mrkdwn <url|text>
function mdLinksToSlack(text) {
  return String(text).replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
}

function cellHasLinks(text) {
  return /\[([^\]]+)\]\(([^)]+)\)/.test(String(text)) || /https?:\/\/\S+/i.test(String(text));
}

function tableHasLinks(header, rows) {
  return [...header, ...rows.flat()].some((c) => cellHasLinks(c));
}

// Convert a cell value to a rich_text element array.
// Handles markdown links [text](url) → link elements, plain text otherwise.
function cellToRichTextElements(cell) {
  const text = String(cell);
  const elements = [];
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let m;
  while ((m = linkRe.exec(text)) !== null) {
    if (m.index > lastIndex) {
      elements.push({ type: "text", text: text.slice(lastIndex, m.index) });
    }
    elements.push({ type: "link", url: m[2], text: m[1] });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    elements.push({ type: "text", text: text.slice(lastIndex) });
  }
  return elements.length > 0 ? elements : [{ type: "text", text: text || " " }];
}

// Strip markdown links to plain text for table cells: [text](url) → text
function stripMdLinks(text) {
  return String(text).replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
}

function findPreferredLinkLabel(header, row, fallbackIndex = 0) {
  const preferredColumns = ["Task", "Title", "Key", "Name", "Project"];
  for (const column of preferredColumns) {
    const index = header.findIndex((value) => String(value).trim().toLowerCase() === column.toLowerCase());
    if (index >= 0 && row[index] && String(row[index]).trim()) {
      return stripMdLinks(String(row[index]).trim());
    }
  }
  const fallback = row[fallbackIndex];
  return stripMdLinks(String(fallback || "").trim()) || "Open";
}

// Extract all markdown links from text as Slack mrkdwn links
function extractLinks(header, rows) {
  const links = [];
  const seen = new Set();
  for (const row of rows) {
    const rowLabel = findPreferredLinkLabel(header, row);
    for (let i = 0; i < row.length; i++) {
      const cell = row[i];
      const text = String(cell);
      const re = /\[([^\]]+)\]\(([^)]+)\)/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (!seen.has(m[2])) {
          seen.add(m[2]);
          const linkLabel = (m[1] && m[1] !== "Open") ? m[1] : rowLabel;
          links.push(`<${m[2]}|${linkLabel}>`);
        }
      }
      const rawUrls = text.match(/https?:\/\/\S+/ig) || [];
      for (const url of rawUrls) {
        if (!seen.has(url)) {
          seen.add(url);
          links.push(`<${url}|${rowLabel}>`);
        }
      }
    }
  }
  return links;
}

function buildSlackTableBlock(header, rows) {
  let workingHeader = [...header];
  let workingRows = rows.map((row) => [...row]);
  const linkColumnIndexes = workingHeader
    .map((value, index) => ({ value: String(value).trim().toLowerCase(), index }))
    .filter(({ value }) => value === "link" || value === "url")
    .map(({ index }) => index);
  if (linkColumnIndexes.length > 0) {
    const removable = linkColumnIndexes.filter((index) =>
      workingRows.every((row) => {
        const cell = String(row[index] || "");
        return !cell || cellHasLinks(cell);
      })
    );
    if (removable.length > 0) {
      workingHeader = workingHeader.filter((_, index) => !removable.includes(index));
      workingRows = workingRows.map((row) => row.filter((_, index) => !removable.includes(index)));
    }
  }

  const colCount = workingHeader.length;
  const hasLinks = tableHasLinks(header, rows);
  const slackCell = (value) => {
    const text = stripMdLinks(value).slice(0, 120);
    return { type: "raw_text", text: text || " " };
  };

  // Always use native table block — strip links from cells to plain text
  const slackRows = [
    workingHeader.map((h) => slackCell(h)),
    ...workingRows.map((row) => {
      const cells = row.map((cell) => slackCell(cell));
      while (cells.length < colCount) cells.push(slackCell(""));
      return cells.slice(0, colCount);
    }),
  ];

  const tableBlock = {
    type: "table",
    column_settings: workingHeader.map(() => ({ is_wrapped: true })),
    rows: slackRows,
  };

  // If links were present, return table + links section
  if (hasLinks) {
    const links = extractLinks(header, rows);
    if (links.length > 0) {
      return [
        tableBlock,
        { type: "context", elements: [{ type: "mrkdwn", text: links.join("  ·  ") }] },
      ];
    }
  }

  return [tableBlock];
}

// Convert markdown formatting to Slack mrkdwn
function mdToSlack(text) {
  return text
    // ## Heading → *Heading* (bold)
    .replace(/^#{1,3}\s+(.+)$/gm, "*$1*")
    // --- horizontal rule → newline
    .replace(/^---$/gm, "")
    // **bold** → *bold* (Slack uses single asterisk)
    // But skip if the content is a URL (don't wrap links in bold asterisks)
    .replace(/\*\*([^*]+)\*\*/g, (match, content) => {
      if (/^https?:\/\//.test(content.trim())) return content.trim();
      return `*${content}*`;
    });
}

function buildSlackTablePayload(response) {
  // Strategy 1: Look for markdown tables (| col | col |)
  const tables = [];
  let match;
  MD_TABLE_RE.lastIndex = 0;
  while ((match = MD_TABLE_RE.exec(response)) !== null) {
    const parsed = parseMarkdownTable(match[1]);
    if (parsed && parsed.header.length >= 2 && parsed.rows.length >= 1) {
      tables.push({ raw: match[1], start: match.index, ...parsed });
    }
  }

  if (tables.length > 0) {
    const blocks = [];
    let cursor = 0;
    for (const table of tables) {
      const before = response.slice(cursor, table.start).trim();
      if (before) blocks.push({ type: "section", text: { type: "mrkdwn", text: mdToSlack(mdLinksToSlack(before)).slice(0, 3000) } });
      blocks.push(...buildSlackTableBlock(table.header, table.rows));
      cursor = table.start + table.raw.length;
    }
    const after = response.slice(cursor).trim();
    if (after) blocks.push({ type: "section", text: { type: "mrkdwn", text: mdToSlack(mdLinksToSlack(after)).slice(0, 3000) } });
    return {
      text: response.slice(0, 200),
      blocks: blocks.slice(0, 20),
    };
  }

  // Strategy 2: Look for structured numbered/bullet lists
  const listData = parseStructuredList(response);
  if (listData) {
    const blocks = [];
    if (listData.before) blocks.push({ type: "section", text: { type: "mrkdwn", text: mdToSlack(mdLinksToSlack(listData.before)).slice(0, 3000) } });
    blocks.push(...buildSlackTableBlock(listData.header, listData.rows));
    if (listData.after) blocks.push({ type: "section", text: { type: "mrkdwn", text: mdToSlack(mdLinksToSlack(listData.after)).slice(0, 3000) } });
    return {
      text: response.slice(0, 200),
      blocks: blocks.slice(0, 20),
    };
  }

  return null;
}

function collapseFreshreleaseTables(response) {
  const lines = String(response || "").split("\n");
  const mergedRows = [];
  let project = "";
  let epicType = "";
  let tableLines = [];

  const flushTable = () => {
    if (!project || tableLines.length === 0) {
      tableLines = [];
      return;
    }
    const parsed = parseMarkdownTable(tableLines.join("\n"));
    tableLines = [];
    if (!parsed) return;
    for (const row of parsed.rows) {
      mergedRows.push([project, epicType, ...row]);
    }
  };

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      flushTable();
      project = line.replace(/^##\s+/, "").trim();
      epicType = "";
      continue;
    }
    if (/^Epic type:\s+/i.test(line)) {
      epicType = line.replace(/^Epic type:\s+/i, "").trim();
      continue;
    }
    if (/^\|/.test(line.trim())) {
      tableLines.push(line.trim());
      continue;
    }
    if (tableLines.length > 0 && line.trim() === "") {
      flushTable();
      continue;
    }
  }
  flushTable();

  if (mergedRows.length === 0) return response;
  const header = ["Project", "Epic Type", "Key", "Title", "Assigned User", "Current State", "Created Date", "Targeted Date", "Updated"];
  const markdown = [
    "Freshrelease results",
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...mergedRows.map((row) => `| ${row.map((cell) => String(cell || "").replace(/\|/g, "/")).join(" | ")} |`),
  ];
  return markdown.join("\n");
}

// ── Pending runs tracker (survives bridge restarts) ──────────────
// Persists in-flight agent runs to disk so a restarted bridge can
// deliver completed results that were orphaned by the restart.

const PENDING_RUNS_FILE = path.join(REPO_DIR, "persist", "pending-slack-runs.json");
const PENDING_RUN_EXPIRE_MS = 20 * 60 * 1000;
const PENDING_RUN_DROP_MS = 6 * 60 * 60 * 1000;
const PENDING_RUN_LAUNCH_EXPIRE_MS = 2 * 60 * 1000;

function loadPendingRuns() {
  try { return JSON.parse(fs.readFileSync(PENDING_RUNS_FILE, "utf-8")); } catch { return {}; }
}

function savePendingRuns(runs) {
  try { fs.writeFileSync(PENDING_RUNS_FILE, JSON.stringify(runs, null, 2)); } catch {}
}

function addPendingRun(sessionId, info) {
  const runs = loadPendingRuns();
  runs[sessionId] = { ...info, startedAt: Date.now(), state: info.state || "launching" };
  savePendingRuns(runs);
}

function updatePendingRun(sessionId, patch) {
  const runs = loadPendingRuns();
  if (!runs[sessionId]) return;
  runs[sessionId] = { ...runs[sessionId], ...patch };
  savePendingRuns(runs);
}

function removePendingRun(sessionId) {
  const runs = loadPendingRuns();
  delete runs[sessionId];
  savePendingRuns(runs);
}

function getPendingRunAgeMs(info, now = Date.now()) {
  return Math.max(0, now - Number(info?.startedAt || 0));
}

function shouldDropPendingRun(info, now = Date.now()) {
  return getPendingRunAgeMs(info, now) > PENDING_RUN_DROP_MS;
}

function shouldExpirePendingRun(info, now = Date.now()) {
  return getPendingRunAgeMs(info, now) > PENDING_RUN_EXPIRE_MS;
}

function shouldExpireLaunchingPendingRun(info, now = Date.now()) {
  return (info?.state || "launching") !== "running"
    && getPendingRunAgeMs(info, now) > PENDING_RUN_LAUNCH_EXPIRE_MS;
}

// On bridge startup: recover orphaned completed runs
async function recoverOrphanedRuns(slackClient) {
  const runs = loadPendingRuns();
  const now = Date.now();
  let recovered = 0;
  let expired = 0;

  for (const [sessionId, info] of Object.entries(runs)) {
    if (shouldDropPendingRun(info, now)) {
      delete runs[sessionId];
      continue;
    }

    if (shouldExpireLaunchingPendingRun(info, now)) {
      if (info.channel && info.thinkingTs) {
        try {
          await slackClient.chat.update({
            token: SLACK_BOT_TOKEN,
            channel: info.channel,
            ts: info.thinkingTs,
            text: "Previous run did not start successfully. Send the request again to retry.",
          });
        } catch (err) {
          console.error(`[recovery] Failed to mark unstarted run ${sessionId}: ${err.message}`);
        }
      }
      delete runs[sessionId];
      expired++;
      continue;
    }

    if (shouldExpirePendingRun(info, now)) {
      if (info.channel && info.thinkingTs) {
        try {
          await slackClient.chat.update({
            token: SLACK_BOT_TOKEN,
            channel: info.channel,
            ts: info.thinkingTs,
            text: "Previous run expired before completion. Send the request again to retry.",
          });
        } catch (err) {
          console.error(`[recovery] Failed to mark expired run ${sessionId}: ${err.message}`);
        }
      }
      delete runs[sessionId];
      expired++;
      continue;
    }

    const tag = `slack-${sessionId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    const rcFile = `/tmp/nemoclaw-agent-${tag}.rc`;
    const outFile = `/tmp/nemoclaw-agent-${tag}.out`;

    let sshConfig;
    try {
      sshConfig = execSync(`"${OPENSHELL}" sandbox ssh-config "${info.sandboxName}"`, { encoding: "utf-8" });
    } catch { continue; }

    const confPath = `/tmp/nemoclaw-recover-${sessionId}.conf`;
    fs.writeFileSync(confPath, sshConfig);

    try {
      const rc = sshExec(confPath, info.sandboxName, `cat ${rcFile} 2>/dev/null || echo __pending__`, 10000);
      if (rc === "__pending__") {
        // Still running — leave it, a new poll will pick it up if user resends
        continue;
      }

      // Completed! Read and deliver
      const raw = sshExec(confPath, info.sandboxName, `cat ${outFile} 2>/dev/null`, 15000);
      sshExec(confPath, info.sandboxName, `rm -f ${outFile} ${rcFile} 2>/dev/null`, 5000);

      const response = filterAgentOutput(raw);
      if (response && info.channel && info.thinkingTs) {
        const tablePayload = buildSlackTablePayload(response);
        if (tablePayload) {
          await slackClient.chat.update({ token: SLACK_BOT_TOKEN, channel: info.channel, ts: info.thinkingTs, ...tablePayload });
        } else {
          await slackClient.chat.update({ token: SLACK_BOT_TOKEN, channel: info.channel, ts: info.thinkingTs, text: response });
        }
        console.log(`[recovery] Delivered orphaned result for ${info.displayName}: ${response.slice(0, 80)}...`);
        recovered++;
      }
    } catch (err) {
      console.error(`[recovery] Failed for ${sessionId}: ${err.message}`);
    } finally {
      try { fs.unlinkSync(confPath); } catch {}
    }

    delete runs[sessionId];
  }

  savePendingRuns(runs);
  if (recovered > 0) console.log(`[recovery] Delivered ${recovered} orphaned result(s)`);
  if (expired > 0) console.log(`[recovery] Expired ${expired} stale pending run(s)`);
}

// ── Run agent inside sandbox (fire-and-poll) ─────────────────────
// Launches the agent in the background inside the sandbox and polls
// for the result via short SSH calls.  This avoids the OpenShell SSH
// proxy killing long-running connections (exit 255).

function filterAgentOutput(raw) {
  // First pass: strip known multi-line noise blocks
  let cleaned = raw
    // Strip [agent] run ... ended with stopReason lines and everything before the first real content
    .replace(/\[agent\] run [^\n]+\n/g, "")
    // Strip "Failing gates:" blocks (multi-line)
    .replace(/Failing gates:[\s\S]*?(?=\n[A-Z]|\n\n)/g, "")
    // Strip "Fix-it keys:" blocks
    .replace(/Fix-it keys:[\s\S]*?(?=\n[A-Z]|\n\n)/g, "")
    // Strip "Context: session=" lines
    .replace(/Context: session=[^\n]+\n/g, "")
    // Strip "Command not found" lines
    .replace(/^Command not found$/gm, "")
    // Strip trailing pipes on heading lines (agent mixes ## headings with table syntax)
    .replace(/^(#{1,3} .+?)\s*\|\s*$/gm, "$1")
    // Strip "On it — delegating to Claude Code" preamble noise
    .replace(/^On it —[^\n]*delegating[^\n]*\n/gm, "")
    // Strip standalone --- horizontal rules
    .replace(/^---\s*$/gm, "");

  // Second pass: line-by-line filter
  return cleaned.split("\n").filter(
    (l) =>
      !l.startsWith("Setting up NemoClaw") &&
      !l.startsWith("[plugins]") &&
      !l.startsWith("[credentials]") &&
      !l.startsWith("[config]") &&
      !l.startsWith("[inject]") &&
      !l.startsWith("[gateway]") &&
      !l.startsWith("[auto-pair]") &&
      !l.startsWith("[diagnostic]") &&
      !l.startsWith("[SECURITY]") &&
      !l.startsWith("[tools]") &&
      !l.startsWith("[agent/") &&
      !l.startsWith("[agent]") &&
      !l.startsWith("[memory]") &&
      !l.startsWith("[SECURITY WARNING]") &&
      !l.startsWith("(node:") &&
      !l.startsWith("(Use node") &&
      !l.startsWith("(Use `node") &&
      !/^\[UNDICI-/.test(l) &&
      !/^Warning:.*EnvHttpProxyAgent/.test(l) &&
      !/^Traceback \(most recent/.test(l) &&
      !/^PermissionError:/.test(l) &&
      !/^Error:.*ENOENT/.test(l) &&
      !/^- tools\.elevated/.test(l) &&
      !/^- agents\.list/.test(l) &&
      !l.includes("NemoClaw ready") &&
      !l.includes("NemoClaw registered") &&
      !l.includes("openclaw agent") &&
      !l.includes("--trace-warnings") &&
      !l.includes("CAP_SETPCAP") &&
      !l.includes("Config integrity check failed") &&
      !l.includes("elevated is not available") &&
      !l.includes("getaddrinfo EAI_AGAIN") &&
      !l.includes("\u250C\u2500") &&
      !l.includes("\u2502 ") &&
      !l.includes("\u2514\u2500") &&
      l.trim() !== "",
  ).join("\n").trim();
}

function sshExec(confPath, sandboxName, cmd, timeoutMs = 30000) {
  try {
    return execFileSync("ssh", ["-T", "-o", "ConnectTimeout=10", "-F", confPath, `openshell-${sandboxName}`, cmd], {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    if (err.stdout) return err.stdout.toString().trim();
    // Fall back to kubectl exec when SSH proxy is broken (e.g. after docker restart)
    try {
      return execFileSync("docker", [
        "exec", "openshell-cluster-nemoclaw",
        "kubectl", "exec", "-n", "openshell", sandboxName, "--",
        "bash", "-c", `export HOME=/sandbox; ${cmd}`,
      ], {
        encoding: "utf-8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (kubectlErr) {
      if (kubectlErr.stdout) return kubectlErr.stdout.toString().trim();
      throw err; // throw original SSH error
    }
  }
}

function getRemoteFileStat(confPath, sandboxName, filePath) {
  const raw = sshExec(confPath, sandboxName, `stat -c '%s %Y' ${filePath} 2>/dev/null || echo __missing__`, 10000);
  if (!raw || raw === "__missing__") return null;
  const [sizeText, mtimeText] = raw.trim().split(/\s+/);
  const size = Number.parseInt(sizeText, 10);
  const mtimeMs = Number.parseInt(mtimeText, 10) * 1000;
  if (!Number.isFinite(size) || !Number.isFinite(mtimeMs)) return null;
  return { size, mtimeMs };
}

function readSessionArtifacts(confPath, sandboxName) {
  try {
    const raw = sshExec(
      confPath,
      sandboxName,
      "cat /sandbox/.openclaw-data/workspace/session-artifacts.json 2>/dev/null || echo __missing__",
      10000,
    );
    if (!raw || raw === "__missing__") return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildArtifactRecoveryResponse(before, after) {
  if (!after || typeof after !== "object") return "";
  const beforePrUrl = before?.pull_request?.url || "";
  const afterPrUrl = after?.pull_request?.url || "";
  if (afterPrUrl && afterPrUrl !== beforePrUrl) {
    const prNumber = after?.pull_request?.number ? `#${after.pull_request.number}` : "created";
    return `PR ${prNumber}: ${afterPrUrl}`;
  }

  const beforeIssueUrl = before?.issue?.url || "";
  const afterIssueUrl = after?.issue?.url || "";
  if (afterIssueUrl && afterIssueUrl !== beforeIssueUrl) {
    const issueNumber = after?.issue?.number ? `#${after.issue.number}` : "created";
    return `Issue ${issueNumber}: ${afterIssueUrl}`;
  }

  return "";
}

async function runAgentInSandbox(message, sessionId, user, options = {}) {
  const sandboxName = user.sandboxName;
  const dbg = (msg) => console.log(`[debug:${sessionId.slice(-12)}] ${msg}`);
  dbg(`START sandbox=${sandboxName} msg="${message.slice(0, 60)}..."`);

  let sshConfig;
  try {
    sshConfig = execSync(`"${OPENSHELL}" sandbox ssh-config "${sandboxName}"`, { encoding: "utf-8" });
  } catch (err) {
    dbg(`FAIL ssh-config: ${err.message}`);
    return `Error: Cannot reach sandbox '${sandboxName}'. Is it running?`;
  }

  const confPath = `/tmp/nemoclaw-slack-ssh-${sessionId}.conf`;
  fs.writeFileSync(confPath, sshConfig);

  // Unique output/status files inside the sandbox
  const tag = `slack-${sessionId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const outFile = `/tmp/nemoclaw-agent-${tag}.out`;
  const rcFile = `/tmp/nemoclaw-agent-${tag}.rc`;
  const artifactBefore = readSessionArtifacts(confPath, sandboxName);

  const agentCmd = buildAgentCommand(message, sessionId, user, options);

  // Fire: launch agent in background, redirect output to file, always attempt to write rc on shell exit.
  const launchCmd = [
    "status=124",
    `trap 'printf \"%s\\n\" \"${"${status:-1}"}\" > ${rcFile}' EXIT`,
    `( ${agentCmd} ) > ${outFile} 2>&1`,
    "status=$?",
    "exit $status",
  ].join("; ");
  try {
    sshExec(confPath, sandboxName, `nohup sh -c '${launchCmd.replace(/'/g, "'\\''")}' </dev/null >/dev/null 2>&1 &`, 15000);
    updatePendingRun(sessionId, { state: "running", launchConfirmedAt: Date.now() });
    dbg("LAUNCHED agent in sandbox");
  } catch (err) {
    dbg(`FAIL launch: ${err.message}`);
    try { fs.unlinkSync(confPath); } catch {}
    return `Error launching agent: ${err.message}`;
  }

  // Poll: wait for rcFile to appear (agent finished)
  const maxWaitMs = 1800000; // 30 minutes
  const pollIntervalMs = 3000;
  const startTime = Date.now();
  let consecutiveFailures = 0;
  let pollCount = 0;
  let lastOutputStat = null;
  let lastOutputProgressAt = startTime;
  dbg(`STALL threshold ${Math.round(STARTUP_STALL_MS / 1000)}s without output progress`);

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    pollCount++;
    try {
      const rc = sshExec(confPath, sandboxName, `cat ${rcFile} 2>/dev/null || echo __pending__`, 10000);
      consecutiveFailures = 0;
      if (rc === "__pending__") {
        const currentStat = getRemoteFileStat(confPath, sandboxName, outFile);
        if (currentStat && (!lastOutputStat
          || currentStat.size !== lastOutputStat.size
          || currentStat.mtimeMs !== lastOutputStat.mtimeMs)) {
          lastOutputProgressAt = Date.now();
          lastOutputStat = currentStat;
          dbg(`OUTPUT progress size=${currentStat.size} at ${Math.round((Date.now() - startTime) / 1000)}s`);
        }
        if (currentStat && Date.now() - lastOutputProgressAt >= STARTUP_STALL_MS) {
          const raw = sshExec(confPath, sandboxName, `cat ${outFile} 2>/dev/null`, 15000);
          const partial = filterAgentOutput(raw);
          if (!partial) {
            const recovered = buildArtifactRecoveryResponse(artifactBefore, readSessionArtifacts(confPath, sandboxName));
            if (recovered) {
              dbg(`RECOVERED from artifacts on stall: "${recovered}"`);
              sshExec(confPath, sandboxName, `rm -f ${outFile} ${rcFile} 2>/dev/null`, 5000);
              try { fs.unlinkSync(confPath); } catch {}
              return recovered;
            }
            dbg(`STALL no progress for ${Math.round((Date.now() - lastOutputProgressAt) / 1000)}s (elapsed ${Math.round((Date.now() - startTime) / 1000)}s)`);
            sshExec(confPath, sandboxName, `rm -f ${outFile} ${rcFile} 2>/dev/null`, 5000);
            try { fs.unlinkSync(confPath); } catch {}
            return buildFriendlyFailure("sandbox", "startup stalled before producing a response");
          }
        }
        if (pollCount % 20 === 0) {
          dbg(`POLLING #${pollCount} (${Math.round((Date.now() - startTime) / 1000)}s elapsed, last output ${Math.round((Date.now() - lastOutputProgressAt) / 1000)}s ago)`);
        }
        continue;
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      dbg(`DONE rc=${rc} polls=${pollCount} elapsed=${elapsed}s`);

      // Agent finished — read output
      const raw = sshExec(confPath, sandboxName, `cat ${outFile} 2>/dev/null`, 15000);
      dbg(`RAW output: ${raw.length} bytes`);
      // Cleanup
      sshExec(confPath, sandboxName, `rm -f ${outFile} ${rcFile} 2>/dev/null`, 5000);
      try { fs.unlinkSync(confPath); } catch {}

      const response = filterAgentOutput(raw);
      dbg(`FILTERED response: ${response.length} bytes, first 80: "${response.slice(0, 80)}"`);
      if (response) return response;
      const recovered = buildArtifactRecoveryResponse(artifactBefore, readSessionArtifacts(confPath, sandboxName));
      if (recovered) {
        dbg(`RECOVERED from artifacts after rc=${rc}: "${recovered}"`);
        return recovered;
      }
      if (rc !== "0") return buildFriendlyFailure("sandbox", raw);
      return "(no response)";
    } catch (err) {
      // Track consecutive SSH failures — bail early if sandbox is permanently unreachable
      consecutiveFailures++;
      if (consecutiveFailures >= 5) {
        dbg(`BAIL ssh failed ${consecutiveFailures}x: ${err.message}`);
        try { fs.unlinkSync(confPath); } catch {}
        return buildFriendlyFailure("sandbox", `sandbox '${sandboxName}' unreachable after ${consecutiveFailures} attempts: ${err.message}`);
      }
      continue;
    }
  }

  dbg(`TIMEOUT after ${Math.round((Date.now() - startTime) / 1000)}s, polls=${pollCount}`);

  // Timeout — try to read whatever output exists
  try {
    const raw = sshExec(confPath, sandboxName, `cat ${outFile} 2>/dev/null`, 10000);
    sshExec(confPath, sandboxName, `rm -f ${outFile} ${rcFile} 2>/dev/null`, 5000);
    try { fs.unlinkSync(confPath); } catch {}
    const partial = filterAgentOutput(raw);
    dbg(`TIMEOUT partial: ${partial.length} bytes`);
    if (partial) return partial + "\n\n_(timed out after 30 minutes)_";
    const recovered = buildArtifactRecoveryResponse(artifactBefore, readSessionArtifacts(confPath, sandboxName));
    if (recovered) {
      dbg(`RECOVERED from artifacts on timeout: "${recovered}"`);
      return recovered;
    }
  } catch {}
  try { fs.unlinkSync(confPath); } catch {}
  return buildFriendlyFailure("sandbox", "timed out");
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
    text = canonicalizeAdminCommand(text);

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

    if (isAddClawCommand(text) || isPurgeClawCommand(text) || isDeleteClawCommand(text) || isConfirmDeleteClawCommand(text)) {
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
        : isPurgeClawCommand(text)
          ? await handlePurgeClaw(user, text)
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

    if (isDM && user && isAdminUser(user) && looksLikeAdminCommand(text)) {
      await reply("Unknown admin command. Use `!admin-help`. Admin commands are handled directly and are not sent to the sandbox agent.");
      return;
    }

    if (isDM && normalizeText(text).startsWith("!") && !isKnownBangCommand(text)) {
      await reply("Unknown command.");
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

    // ── !whatsapp commands (run on host — WS can't go through sandbox proxy) ──
    if (/^!whatsapp\b|^!wa\b/i.test(normalizeText(text))) {
      if (!user) {
        await reply("You're not registered. Ask an admin to run `nemoclaw user-add`.");
        return;
      }
      const waCmd = normalizeText(text).replace(/^!(whatsapp|wa)\s*/i, "").trim();
      if (!waCmd || waCmd === "help") {
        await reply("WhatsApp commands:\n`!wa send <phone> <message>` — Send a message\n`!wa contacts [--query <name>]` — List/search contacts\n`!wa inbox` — List recent conversations\n`!wa read <phone> [--count N]` — Read messages");
        return;
      }
      try {
        const result = execFileSync("node", [`${REPO_DIR}/scripts/whatsapp-bridge.js`, ...waCmd.split(/\s+/)], {
          encoding: "utf-8",
          timeout: 45000,
          env: { ...process.env, SLACK_USER_ID: user.slackUserId },
        }).trim();
        await reply(result || "(no output)");
      } catch (err) {
        const stderr = err.stderr ? err.stderr.toString().slice(0, 300) : "";
        const stdout = err.stdout ? err.stdout.toString().slice(0, 300) : "";
        await reply(`WhatsApp error: ${stdout || stderr || err.message}`.slice(0, 500));
      }
      return;
    }

    // ── !yahoo commands (run on host, not sandbox — IMAP needs direct TCP) ──
    if (/^!yahoo\b/i.test(normalizeText(text))) {
      if (!user) {
        await reply("You're not registered. Ask an admin to run `nemoclaw user-add`.");
        return;
      }
      const yahooCmd = normalizeText(text).slice("!yahoo ".length).trim();
      // Map !yahoo subcommands to script args
      let scriptArgs;
      if (/^inbox\b/i.test(yahooCmd)) {
        const countMatch = yahooCmd.match(/--count\s+(\d+)/);
        const count = countMatch ? countMatch[1] : "10";
        scriptArgs = ["inbox", "--count", count, ...(/\b--unread\b/i.test(yahooCmd) ? ["--unread"] : [])];
      } else if (/^read\s+(\d+)/i.test(yahooCmd)) {
        scriptArgs = ["read", yahooCmd.match(/^read\s+(\d+)/i)[1]];
      } else if (/^send\b/i.test(yahooCmd)) {
        const toMatch = yahooCmd.match(/--to\s+(\S+)/);
        const subjMatch = yahooCmd.match(/--subject\s+"([^"]+)"|--subject\s+(\S+)/);
        const bodyMatch = yahooCmd.match(/--body\s+"([^"]+)"|--body\s+(\S+)/);
        const ccMatch = yahooCmd.match(/--cc\s+(\S+)/);
        if (!toMatch || !subjMatch || !bodyMatch) {
          await reply("Usage: `!yahoo send --to addr@example.com --subject \"Subject\" --body \"Body text\"` [--cc addr]");
          return;
        }
        const to = toMatch[1];
        const subj = subjMatch[1] || subjMatch[2];
        const body = bodyMatch[1] || bodyMatch[2];
        scriptArgs = ["send", "--to", to, "--subject", subj, "--body", body];
        if (ccMatch) scriptArgs.push("--cc", ccMatch[1]);
      } else if (/^search\b/i.test(yahooCmd)) {
        const query = yahooCmd.replace(/^search\s+/i, "").trim();
        scriptArgs = ["search", query];
      } else {
        await reply("Yahoo Mail commands:\n`!yahoo inbox [--count N] [--unread]`\n`!yahoo read <message-id>`\n`!yahoo send --to <addr> --subject \"...\" --body \"...\"`\n`!yahoo search <query>`");
        return;
      }
      try {
        const result = runYahooHelper(user, scriptArgs);
        await reply(result || "(no output)");
      } catch (err) {
        await reply(`Yahoo mail error: ${(err.stderr || err.message || "").slice(0, 500)}`);
      }
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
    const requestedRetry = isRetryCommand(text);
    const priorUserRequest = getRecordedLastUserRequest(user.slackUserId);
    let effectiveText = text;
    if (requestedRetry && priorUserRequest) {
      effectiveText = priorUserRequest;
    }
    if (!requestedRetry) {
      recordLastUserRequest(user.slackUserId, text);
    }
    console.log(`[${channel}] ${displayName} → ${user.sandboxName}: ${effectiveText}`);

    try {
      let yahooRequest = parseYahooRequest(effectiveText);
      if (!yahooRequest) {
        const recordedEmailRequest = getRecordedEmailRequest(user.slackUserId);
        const refinement = extractMailRefinement(effectiveText);
        if (recordedEmailRequest && refinement) {
          yahooRequest = { ...recordedEmailRequest, ...refinement };
        }
      }
      if (yahooRequest && hasYahooCredentials(user)) {
        const thinkingMsg = await app.client.chat.postMessage({
          token: SLACK_BOT_TOKEN,
          channel,
          thread_ts: threadTs,
          text: "Fetching email data...",
        });
        try {
          recordEmailRequest(user.slackUserId, yahooRequest);
          const response = redactSensitiveText(runEmailHelper(user, yahooRequest), user);
          const tablePayload = buildSlackTablePayload(response);
          if (tablePayload) {
            await app.client.chat.update({
              token: SLACK_BOT_TOKEN,
              channel,
              ts: thinkingMsg.ts,
              ...tablePayload,
            });
          } else {
            await app.client.chat.update({
              token: SLACK_BOT_TOKEN,
              channel,
              ts: thinkingMsg.ts,
              text: response.slice(0, 3800),
            });
          }
        } catch (err) {
          const detail = redactSensitiveText(`${err.stdout || ""}${err.stderr || ""}`.trim() || err.message, user);
          console.error(`[email] ${detail}`);
          await app.client.chat.update({
            token: SLACK_BOT_TOKEN,
            channel,
            ts: thinkingMsg.ts,
            text: buildFriendlyFailure("Email", detail),
          });
        }
        return;
      }

      const thinkingMsg = await app.client.chat.postMessage({
        token: SLACK_BOT_TOKEN,
        channel,
        thread_ts: threadTs,
        text: "Working on it...",
      });

      // Serialize agent runs per sandbox to avoid OpenClaw lane lock conflicts.
      // Messages queue up and run one at a time per sandbox.
      const agentSessionId = `${event.user}-${channel}-${Date.now()}`;

      // Track pending run on disk so a restarted bridge can deliver the result
      addPendingRun(agentSessionId, {
        sandboxName: user.sandboxName,
        channel,
        thinkingTs: thinkingMsg.ts,
        displayName,
        slackUserId: event.user,
        state: "launching",
      });

      let response = await enqueueForUser(user.sandboxName, async () => {
        // Wait for rate limit cooldown before launching
        if (isRateLimited()) {
          await app.client.chat.update({
            token: SLACK_BOT_TOKEN,
            channel,
            ts: thinkingMsg.ts,
            text: "Rate limited — waiting for cooldown, then switching to NVIDIA Nemotron...",
          });
          await waitForRateLimitCooldown();
        }

        // Don't override the sandbox's configured primary model — it may be Ollama, not Anthropic

        let result = await runAgentInSandbox(effectiveText, agentSessionId, user);
        console.log(`[${channel}] ${user.sandboxName} → ${displayName}: ${result.slice(0, 100)}...`);

        // On rate limit: trigger cooldown, attempt NVIDIA fallback immediately
        if (RATE_LIMIT_RE.test(result)) {
          console.log(`[${channel}] Rate limit detected for ${user.sandboxName}, switching to NVIDIA Nemotron...`);
          triggerRateLimitCooldown();
          await app.client.chat.update({
            token: SLACK_BOT_TOKEN,
            channel,
            ts: thinkingMsg.ts,
            text: "Anthropic rate limited — trying NVIDIA Nemotron...",
          });
          result = await attemptFallbackRouting(user, effectiveText, `${event.user}-${channel}-${Date.now()}`, channel, displayName);
        }

        // On auth error: refresh credentials and retry once before giving up
        if (AUTH_ERROR_RE.test(result)) {
          console.log(`[${channel}] Auth error detected for ${user.sandboxName}, refreshing credentials and retrying...`);
          await app.client.chat.update({
            token: SLACK_BOT_TOKEN,
            channel,
            ts: thinkingMsg.ts,
            text: "Refreshing credentials, one moment...",
          });
          if (refreshCredentials(user.sandboxName, user.credentialsDir || "")) {
            result = await runAgentInSandbox(effectiveText, `${event.user}-${channel}-${Date.now()}-retry`, user);
            console.log(`[${channel}] ${user.sandboxName} → ${displayName} (retry): ${result.slice(0, 100)}...`);
          }
          if (AUTH_ERROR_RE.test(result)) {
            result = await attemptFallbackRouting(user, effectiveText, `${event.user}-${channel}-${Date.now()}`, channel, displayName);
          }
        }
        return result;
      });

      // Redact credential/auth errors in public channels — only show details in DMs
      const isAuthError = AUTH_ERROR_RE.test(response);
      if (isAuthError && !isDM) {
        console.error(`[${channel}] suppressing auth error in public channel for ${displayName}`);
        response = "I'm having a temporary issue — please try again in a few minutes or DM me directly.";
      }

      // Convert markdown to Slack format, then build table blocks
      response = sanitizeUserFacingResponse(redactSensitiveText(response, user));
      response = mdToSlack(mdLinksToSlack(response));
      const tablePayload = buildSlackTablePayload(response);
      if (tablePayload) {
        await app.client.chat.update({
          token: SLACK_BOT_TOKEN,
          channel,
          ts: thinkingMsg.ts,
          ...tablePayload,
        });
      } else {
        await app.client.chat.update({
          token: SLACK_BOT_TOKEN,
          channel,
          ts: thinkingMsg.ts,
          text: mdToSlack(mdLinksToSlack(response)),
        });
      }

      // Forward notification-like responses to WhatsApp
      if (isDM) maybeForwardToWhatsApp(user, response);

      // Remove from pending runs — delivery succeeded
      removePendingRun(agentSessionId);
    } catch (err) {
      removePendingRun(agentSessionId);
      console.error(`[${channel}] error for ${displayName}:`, err.message);
      // Redact auth errors in public channels
      const errMsg = err.message || "";
      const isAuthErr = /authentication_error|invalid_grant|Invalid authentication|401.*auth/i.test(errMsg);
      const safeMsg = (!isDM && isAuthErr)
        ? "I'm having a temporary issue — please try again in a few minutes or DM me directly."
        : buildFriendlyFailure("request", errMsg);
      await say({ text: safeMsg, thread_ts: threadTs });
    }
  }

  await app.start();

  // Recover orphaned results from previous bridge instance
  await recoverOrphanedRuns(app.client).catch((err) => {
    console.error(`[recovery] Error: ${err.message}`);
  });

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
  canonicalizeAdminCommand,
  looksLikeAdminCommand,
  isAddClawCommand,
  isPurgeClawCommand,
  isDeleteClawCommand,
  isConfirmDeleteClawCommand,
  isKnownBangCommand,
  parseSandboxList,
  formatDurationFrom,
  getInventoryStatus,
  listConfiguredCredentials,
  buildClawInventory,
  parseShowClawsOptions,
  filterAndSortClawInventory,
  formatClawInventory,
  isRetryCommand,
  hasYahooCredentials,
  parseYahooRequest,
  extractMailRefinement,
  runYahooHelper,
  collapseFreshreleaseTables,
  redactSensitiveText,
  sanitizeUserFacingResponse,
  recordLastUserRequest,
  getRecordedLastUserRequest,
  getPendingRunAgeMs,
  shouldExpireLaunchingPendingRun,
  shouldExpirePendingRun,
  shouldDropPendingRun,
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
  buildAuthRecoveryMessage,
  buildAgentCommand,
  getRuntimeFallbackModels,
};
