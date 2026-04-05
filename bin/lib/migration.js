// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");

const { ROOT } = require("./runner");

const BUNDLE_VERSION = 1;

function resolveRepoRoot(repoRoot = ROOT) {
  return path.resolve(repoRoot);
}

function resolveHomeDir(homeDir = process.env.HOME || os.homedir() || "/tmp") {
  return path.resolve(homeDir);
}

function resolveRegistryRoot(homeDir) {
  return path.join(resolveHomeDir(homeDir), ".nemoclaw");
}

function resolveBundleRoot(repoRoot, outputDir) {
  if (outputDir) {
    return path.isAbsolute(outputDir)
      ? path.resolve(outputDir)
      : path.resolve(resolveRepoRoot(repoRoot), outputDir);
  }
  const stamp = new Date().toISOString().replace(/[:]/g, "-");
  return path.join(resolveRepoRoot(repoRoot), "persist", "migration", `multi-user-${stamp}`);
}

function readJsonIfExists(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {
    /* ignored */
  }
  return fallback;
}

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function writeJson(filePath, value) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function ensureTargetAbsent(targetPath, force) {
  if (!fs.existsSync(targetPath)) return;
  if (force) {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return;
  }
  throw new Error(`Refusing to overwrite existing path without --force: ${targetPath}`);
}

function listRelativeFiles(rootPath) {
  if (!fs.existsSync(rootPath)) return [];
  const files = [];
  const walk = (currentPath, relativeBase = "") => {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const nextRelative = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
      const nextPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(nextPath, nextRelative);
      } else if (entry.isFile()) {
        files.push(nextRelative);
      }
    }
  };
  walk(rootPath);
  return files.sort();
}

function copyEntry(srcPath, dstPath) {
  const stat = fs.lstatSync(srcPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to copy symlink: ${srcPath}`);
  }
  if (stat.isDirectory()) {
    mkdirp(dstPath);
    for (const entry of fs.readdirSync(srcPath, { withFileTypes: true })) {
      copyEntry(path.join(srcPath, entry.name), path.join(dstPath, entry.name));
    }
    fs.chmodSync(dstPath, stat.mode);
    return;
  }
  if (!stat.isFile()) {
    return;
  }
  mkdirp(path.dirname(dstPath));
  fs.copyFileSync(srcPath, dstPath);
  fs.chmodSync(dstPath, stat.mode);
}

function copyIfExists(srcPath, dstPath, copied) {
  if (!fs.existsSync(srcPath)) return false;
  copyEntry(srcPath, dstPath);
  copied.push({
    source: srcPath,
    destination: dstPath,
    type: fs.lstatSync(srcPath).isDirectory() ? "directory" : "file",
  });
  return true;
}

function detectCredentialKinds(credentialsDir) {
  const checks = [
    ["anthropic-key", "anthropic-key.txt"],
    ["claude-token", "claude-oauth-token.txt"],
    ["claude-credentials", "claude-credentials.json"],
    ["claude-settings", "claude-settings.json"],
    ["github", "gh-hosts.yml"],
    ["gogcli", "gogcli"],
    ["freshrelease", "freshrelease-api-key.txt"],
    ["yahoo", "yahoo-creds.env"],
    ["whatsapp-number", "whatsapp-number.txt"],
    ["whatsapp-auth", "whatsapp-auth"],
    ["slack-webhook", "slack-webhook-url.txt"],
    ["google-service-account", "service-account.json"],
  ];
  return checks
    .filter(([, relativePath]) => fs.existsSync(path.join(credentialsDir, relativePath)))
    .map(([name]) => name);
}

function readOptionalText(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8").trim() : null;
  } catch {
    return null;
  }
}

function collectNotificationInventory(credentialsDir) {
  return {
    slackWebhook: fs.existsSync(path.join(credentialsDir, "slack-webhook-url.txt")),
    yahooSummary: fs.existsSync(path.join(credentialsDir, "yahoo-creds.env")),
    whatsappForwarding:
      fs.existsSync(path.join(credentialsDir, "whatsapp-number.txt")) ||
      fs.existsSync(path.join(credentialsDir, "whatsapp-auth")),
    googleSummaries:
      fs.existsSync(path.join(credentialsDir, "gogcli", "config.json")) ||
      fs.existsSync(path.join(credentialsDir, "service-account.json")),
  };
}

function collectServiceInventory(credentialsDir, workspaceDir) {
  return {
    anthropicToken:
      fs.existsSync(path.join(credentialsDir, "claude-oauth-token.txt")) ||
      fs.existsSync(path.join(credentialsDir, "anthropic-key.txt")),
    claudeCredentials: fs.existsSync(path.join(credentialsDir, "claude-credentials.json")),
    github: fs.existsSync(path.join(credentialsDir, "gh-hosts.yml")),
    googleGogcli: fs.existsSync(path.join(credentialsDir, "gogcli", "config.json")),
    googleServiceAccount: fs.existsSync(path.join(credentialsDir, "service-account.json")),
    freshreleaseRest: fs.existsSync(path.join(credentialsDir, "freshrelease-api-key.txt")),
    yahoo: fs.existsSync(path.join(credentialsDir, "yahoo-creds.env")),
    whatsappNumber: fs.existsSync(path.join(credentialsDir, "whatsapp-number.txt")),
    whatsappAuth: fs.existsSync(path.join(credentialsDir, "whatsapp-auth")),
    slackWebhook: fs.existsSync(path.join(credentialsDir, "slack-webhook-url.txt")),
    memory: fs.existsSync(path.join(workspaceDir, "MEMORY.md")),
    soul: fs.existsSync(path.join(workspaceDir, "SOUL.md")),
    identity: fs.existsSync(path.join(workspaceDir, "IDENTITY.md")),
    tools: fs.existsSync(path.join(workspaceDir, "TOOLS.md")),
    heartbeat: fs.existsSync(path.join(workspaceDir, "HEARTBEAT.md")),
    agents: fs.existsSync(path.join(workspaceDir, "AGENTS.md")),
    userContext: fs.existsSync(path.join(workspaceDir, "USER.md")),
  };
}

function loadUxSnapshots(repoRoot) {
  const snapshots = { setupHelp: null, adminHelp: null };
  const candidateRoots = [...new Set([repoRoot, ROOT].filter(Boolean).map((value) => path.resolve(value)))];
  let setupModule = null;
  let slackBridgeModule = null;
  for (const root of candidateRoots) {
    if (!setupModule) {
      try {
        setupModule = require(path.join(root, "bin", "lib", "credential-setup.js"));
      } catch {
        /* ignored */
      }
    }
    if (!slackBridgeModule) {
      try {
        slackBridgeModule = require(path.join(root, "scripts", "slack-bridge-multi.js"));
      } catch {
        /* ignored */
      }
    }
  }
  try {
    const { setupHelp } = setupModule || {};
    if (typeof setupHelp === "function") snapshots.setupHelp = setupHelp();
  } catch {
    /* ignored */
  }
  try {
    const { formatAdminHelp } = slackBridgeModule || {};
    if (typeof formatAdminHelp === "function") snapshots.adminHelp = formatAdminHelp();
  } catch {
    /* ignored */
  }
  return snapshots;
}

function buildNotificationScriptInventory(repoRoot) {
  const candidateRoots = [...new Set([repoRoot, ROOT].filter(Boolean).map((value) => path.resolve(value)))];
  const hasScript = (relativePath) =>
    candidateRoots.some((root) => fs.existsSync(path.join(root, relativePath)));
  return {
    notify: hasScript(path.join("scripts", "notify.sh")),
    yahooUnread: hasScript(path.join("scripts", "check-yahoo-unread.sh")),
    slackToWhatsApp: hasScript(path.join("scripts", "forward-slack-to-whatsapp.sh")),
    slackNotify: hasScript(path.join("scripts", "slack-notify.sh")),
  };
}

function buildHostEnvInventory(repoRoot) {
  const hostEnvPath = path.join(repoRoot, ".env");
  const raw = readOptionalText(hostEnvPath);
  if (!raw) {
    return {
      present: false,
      slackWebhook: false,
      slackBotToken: false,
      slackAppToken: false,
    };
  }
  return {
    present: true,
    slackWebhook: /^SLACK_WEBHOOK_URL=/m.test(raw),
    slackBotToken: /^SLACK_BOT_TOKEN=/m.test(raw),
    slackAppToken: /^SLACK_APP_TOKEN=/m.test(raw),
  };
}

function buildUserManifestEntry(userId, entry, repoRoot) {
  const resolvedCredentialsDir = path.isAbsolute(entry.credentialsDir || "")
    ? path.resolve(entry.credentialsDir)
    : path.join(repoRoot, entry.credentialsDir || `persist/users/${userId}/credentials`);
  const resolvedWorkspaceDir = path.isAbsolute(entry.personalityDir || "")
    ? path.resolve(entry.personalityDir)
    : path.join(repoRoot, entry.personalityDir || `persist/users/${userId}/workspace`);
  return {
    slackUserId: entry.slackUserId || userId,
    slackDisplayName: entry.slackDisplayName || "",
    sandboxName: entry.sandboxName || null,
    githubUser: entry.githubUser || "",
    enabled: entry.enabled !== false,
    timezone: entry.timezone || "UTC",
    roles: Array.isArray(entry.roles) ? entry.roles : [],
    createdAt: entry.createdAt || null,
    credentialsDir: path.relative(repoRoot, resolvedCredentialsDir),
    personalityDir: path.relative(repoRoot, resolvedWorkspaceDir),
    credentialKinds: detectCredentialKinds(resolvedCredentialsDir),
    credentialFiles: listRelativeFiles(resolvedCredentialsDir),
    workspaceFiles: listRelativeFiles(resolvedWorkspaceDir),
    notificationInventory: collectNotificationInventory(resolvedCredentialsDir),
    serviceInventory: collectServiceInventory(resolvedCredentialsDir, resolvedWorkspaceDir),
    metadata: {
      whatsappNumber: readOptionalText(path.join(resolvedCredentialsDir, "whatsapp-number.txt")),
      primaryModelPreference: readOptionalText(path.join(resolvedCredentialsDir, "primary-model.txt")),
      slackWebhookConfigured: fs.existsSync(path.join(resolvedCredentialsDir, "slack-webhook-url.txt")),
    },
  };
}

function loadCurrentState({ repoRoot = ROOT, homeDir } = {}) {
  const resolvedRepoRoot = resolveRepoRoot(repoRoot);
  const registryRoot = resolveRegistryRoot(homeDir);
  const usersFile = path.join(registryRoot, "users.json");
  const sandboxesFile = path.join(registryRoot, "sandboxes.json");
  const usersState = readJsonIfExists(usersFile, { users: {}, defaultUser: null, deletedUsers: [] });
  const sandboxesState = readJsonIfExists(sandboxesFile, { sandboxes: {}, defaultSandbox: null });
  const users = {};
  for (const [userId, entry] of Object.entries(usersState.users || {})) {
    users[userId] = buildUserManifestEntry(userId, entry, resolvedRepoRoot);
  }
  return {
    repoRoot: resolvedRepoRoot,
    registryRoot,
    usersFile,
    sandboxesFile,
    usersState,
    sandboxesState,
    users,
  };
}

function exportMultiUserState({ repoRoot = ROOT, homeDir, outputDir } = {}) {
  const state = loadCurrentState({ repoRoot, homeDir });
  const bundleRoot = resolveBundleRoot(state.repoRoot, outputDir);
  if (fs.existsSync(bundleRoot) && fs.readdirSync(bundleRoot).length > 0) {
    throw new Error(`Output directory already exists and is not empty: ${bundleRoot}`);
  }
  mkdirp(bundleRoot);

  const copied = [];
  const registryBundleDir = path.join(bundleRoot, "registry");
  const usersBundleDir = path.join(bundleRoot, "users");
  const sharedBundleDir = path.join(bundleRoot, "shared");

  copyIfExists(state.usersFile, path.join(registryBundleDir, "users.json"), copied);
  copyIfExists(state.sandboxesFile, path.join(registryBundleDir, "sandboxes.json"), copied);

  for (const userId of Object.keys(state.users).sort()) {
    const srcDir = path.join(state.repoRoot, "persist", "users", userId);
    copyIfExists(srcDir, path.join(usersBundleDir, userId), copied);
  }

  copyIfExists(
    path.join(state.repoRoot, "persist", "audit", "admin-actions.log"),
    path.join(sharedBundleDir, "audit", "admin-actions.log"),
    copied,
  );
  copyIfExists(
    path.join(state.repoRoot, "persist", "pending-slack-runs.json"),
    path.join(sharedBundleDir, "pending-slack-runs.json"),
    copied,
  );
  copyIfExists(
    path.join(state.repoRoot, "persist", "gateway"),
    path.join(sharedBundleDir, "gateway"),
    copied,
  );
  copyIfExists(
    path.join(state.repoRoot, ".env"),
    path.join(sharedBundleDir, "host", ".env"),
    copied,
  );

  const manifest = {
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      repoRoot: state.repoRoot,
      homeDir: resolveHomeDir(homeDir),
    },
    registries: {
      defaultUser: state.usersState.defaultUser || null,
      deletedUsers: Array.isArray(state.usersState.deletedUsers) ? state.usersState.deletedUsers : [],
      defaultSandbox: state.sandboxesState.defaultSandbox || null,
    },
    ux: loadUxSnapshots(state.repoRoot),
    users: state.users,
    shared: {
      adminAuditLog: fs.existsSync(path.join(state.repoRoot, "persist", "audit", "admin-actions.log")),
      pendingRuns: fs.existsSync(path.join(state.repoRoot, "persist", "pending-slack-runs.json")),
      gateway: fs.existsSync(path.join(state.repoRoot, "persist", "gateway")),
      hostEnv: buildHostEnvInventory(state.repoRoot),
      notificationScripts: buildNotificationScriptInventory(state.repoRoot),
    },
    copied,
  };

  writeJson(path.join(bundleRoot, "manifest.json"), manifest);
  return { bundleRoot, manifest };
}

function importMultiUserState({ repoRoot = ROOT, homeDir, inputDir, force = false } = {}) {
  if (!inputDir) {
    throw new Error("inputDir is required");
  }
  const resolvedRepoRoot = resolveRepoRoot(repoRoot);
  const resolvedInputDir = path.isAbsolute(inputDir)
    ? path.resolve(inputDir)
    : path.resolve(resolvedRepoRoot, inputDir);
  const manifestPath = path.join(resolvedInputDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Migration bundle manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  if (manifest.version !== BUNDLE_VERSION) {
    throw new Error(`Unsupported migration bundle version: ${manifest.version}`);
  }

  const registryRoot = resolveRegistryRoot(homeDir);
  const usersTargetRoot = path.join(resolvedRepoRoot, "persist", "users");
  const sharedTargetRoot = path.join(resolvedRepoRoot, "persist");

  const copied = [];
  const usersRegistrySrc = path.join(resolvedInputDir, "registry", "users.json");
  const sandboxesRegistrySrc = path.join(resolvedInputDir, "registry", "sandboxes.json");
  const auditSrc = path.join(resolvedInputDir, "shared", "audit", "admin-actions.log");
  const pendingRunsSrc = path.join(resolvedInputDir, "shared", "pending-slack-runs.json");
  const gatewaySrc = path.join(resolvedInputDir, "shared", "gateway");
  const hostEnvSrc = path.join(resolvedInputDir, "shared", "host", ".env");

  ensureTargetAbsent(path.join(registryRoot, "users.json"), force);
  ensureTargetAbsent(path.join(registryRoot, "sandboxes.json"), force);
  for (const userId of Object.keys(manifest.users || {})) {
    ensureTargetAbsent(path.join(usersTargetRoot, userId), force);
  }
  if (manifest.shared?.adminAuditLog) {
    ensureTargetAbsent(path.join(sharedTargetRoot, "audit", "admin-actions.log"), force);
  }
  if (manifest.shared?.pendingRuns) {
    ensureTargetAbsent(path.join(sharedTargetRoot, "pending-slack-runs.json"), force);
  }
  if (manifest.shared?.gateway) {
    ensureTargetAbsent(path.join(sharedTargetRoot, "gateway"), force);
  }
  if (manifest.shared?.hostEnv?.present) {
    ensureTargetAbsent(path.join(resolvedRepoRoot, ".env"), force);
  }

  copyIfExists(usersRegistrySrc, path.join(registryRoot, "users.json"), copied);
  copyIfExists(sandboxesRegistrySrc, path.join(registryRoot, "sandboxes.json"), copied);
  for (const userId of Object.keys(manifest.users || {}).sort()) {
    copyIfExists(path.join(resolvedInputDir, "users", userId), path.join(usersTargetRoot, userId), copied);
  }
  copyIfExists(auditSrc, path.join(sharedTargetRoot, "audit", "admin-actions.log"), copied);
  copyIfExists(pendingRunsSrc, path.join(sharedTargetRoot, "pending-slack-runs.json"), copied);
  copyIfExists(gatewaySrc, path.join(sharedTargetRoot, "gateway"), copied);
  copyIfExists(hostEnvSrc, path.join(resolvedRepoRoot, ".env"), copied);

  const restoreMarker = {
    importedAt: new Date().toISOString(),
    sourceBundle: resolvedInputDir,
    version: manifest.version,
    usersRestored: Object.keys(manifest.users || {}),
    force,
  };
  writeJson(
    path.join(resolvedRepoRoot, "persist", "migration", "last-import.json"),
    restoreMarker,
  );

  return {
    bundleRoot: resolvedInputDir,
    manifest,
    copied,
    restoreMarker,
  };
}

function restoreUserFromBundle({
  repoRoot = ROOT,
  homeDir,
  inputDir,
  slackUserId,
  force = false,
} = {}) {
  if (!inputDir) throw new Error("inputDir is required");
  if (!slackUserId) throw new Error("slackUserId is required");

  const resolvedRepoRoot = resolveRepoRoot(repoRoot);
  const resolvedInputDir = path.isAbsolute(inputDir)
    ? path.resolve(inputDir)
    : path.resolve(resolvedRepoRoot, inputDir);
  const manifestPath = path.join(resolvedInputDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Migration bundle manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const userManifest = manifest.users?.[slackUserId];
  if (!userManifest) {
    throw new Error(`User ${slackUserId} not found in migration bundle.`);
  }

  const registryRoot = resolveRegistryRoot(homeDir);
  const usersRegistryPath = path.join(registryRoot, "users.json");
  const sandboxesRegistryPath = path.join(registryRoot, "sandboxes.json");
  const bundleUsersRegistry = readJsonIfExists(
    path.join(resolvedInputDir, "registry", "users.json"),
    { users: {}, defaultUser: null, deletedUsers: [] },
  );
  const bundleSandboxesRegistry = readJsonIfExists(
    path.join(resolvedInputDir, "registry", "sandboxes.json"),
    { sandboxes: {}, defaultSandbox: null },
  );
  const currentUsersRegistry = readJsonIfExists(usersRegistryPath, {
    users: {},
    defaultUser: null,
    deletedUsers: [],
  });
  const currentSandboxesRegistry = readJsonIfExists(sandboxesRegistryPath, {
    sandboxes: {},
    defaultSandbox: null,
  });
  if (!currentUsersRegistry.users || typeof currentUsersRegistry.users !== "object") {
    currentUsersRegistry.users = {};
  }
  if (!Array.isArray(currentUsersRegistry.deletedUsers)) {
    currentUsersRegistry.deletedUsers = [];
  }
  if (!currentSandboxesRegistry.sandboxes || typeof currentSandboxesRegistry.sandboxes !== "object") {
    currentSandboxesRegistry.sandboxes = {};
  }

  if (!force && currentUsersRegistry.users?.[slackUserId]) {
    throw new Error(`User ${slackUserId} already exists in target registry. Pass --force to overwrite.`);
  }

  const copied = [];
  const targetUserDir = path.join(resolvedRepoRoot, "persist", "users", slackUserId);
  ensureTargetAbsent(targetUserDir, force);
  copyIfExists(path.join(resolvedInputDir, "users", slackUserId), targetUserDir, copied);

  const bundleUserEntry = bundleUsersRegistry.users?.[slackUserId];
  if (bundleUserEntry) {
    currentUsersRegistry.users[slackUserId] = bundleUserEntry;
  } else {
    currentUsersRegistry.users[slackUserId] = {
      slackUserId,
      slackDisplayName: userManifest.slackDisplayName || "",
      sandboxName: userManifest.sandboxName || null,
      githubUser: userManifest.githubUser || "",
      createdAt: userManifest.createdAt || new Date().toISOString(),
      personalityDir: userManifest.personalityDir,
      credentialsDir: userManifest.credentialsDir,
      enabled: userManifest.enabled !== false,
      timezone: userManifest.timezone || "UTC",
      roles: userManifest.roles || ["user"],
    };
  }
  if (!currentUsersRegistry.defaultUser) {
    currentUsersRegistry.defaultUser = manifest.registries?.defaultUser || slackUserId;
  }
  const deletedUsers = new Set(currentUsersRegistry.deletedUsers || []);
  deletedUsers.delete(slackUserId);
  currentUsersRegistry.deletedUsers = [...deletedUsers];

  if (userManifest.sandboxName && bundleSandboxesRegistry.sandboxes?.[userManifest.sandboxName]) {
    currentSandboxesRegistry.sandboxes[userManifest.sandboxName] =
      bundleSandboxesRegistry.sandboxes[userManifest.sandboxName];
    if (!currentSandboxesRegistry.defaultSandbox) {
      currentSandboxesRegistry.defaultSandbox =
        bundleSandboxesRegistry.defaultSandbox || userManifest.sandboxName;
    }
  }

  writeJson(usersRegistryPath, currentUsersRegistry);
  writeJson(sandboxesRegistryPath, currentSandboxesRegistry);

  const restoreMarker = {
    restoredAt: new Date().toISOString(),
    sourceBundle: resolvedInputDir,
    slackUserId,
    sandboxName: userManifest.sandboxName || null,
    force,
  };
  writeJson(
    path.join(resolvedRepoRoot, "persist", "migration", "restored-users", `${slackUserId}.json`),
    restoreMarker,
  );

  return {
    bundleRoot: resolvedInputDir,
    slackUserId,
    user: userManifest,
    copied,
    restoreMarker,
  };
}

function restoreAllUsersFromBundle({
  repoRoot = ROOT,
  homeDir,
  inputDir,
  force = false,
  includeDisabled = false,
} = {}) {
  if (!inputDir) throw new Error("inputDir is required");
  const resolvedRepoRoot = resolveRepoRoot(repoRoot);
  const resolvedInputDir = path.isAbsolute(inputDir)
    ? path.resolve(inputDir)
    : path.resolve(resolvedRepoRoot, inputDir);
  const manifestPath = path.join(resolvedInputDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Migration bundle manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const userIds = Object.entries(manifest.users || {})
    .filter(([, user]) => includeDisabled || user.enabled !== false)
    .map(([slackUserId]) => slackUserId)
    .sort();
  const results = [];
  for (const slackUserId of userIds) {
    results.push(
      restoreUserFromBundle({
        repoRoot: resolvedRepoRoot,
        homeDir,
        inputDir: resolvedInputDir,
        slackUserId,
        force,
      }),
    );
  }
  return {
    bundleRoot: resolvedInputDir,
    restoredUsers: results,
  };
}

function inspectMultiUserState({ repoRoot = ROOT, inputDir } = {}) {
  if (!inputDir) {
    throw new Error("inputDir is required");
  }
  const resolvedRepoRoot = resolveRepoRoot(repoRoot);
  const resolvedInputDir = path.isAbsolute(inputDir)
    ? path.resolve(inputDir)
    : path.resolve(resolvedRepoRoot, inputDir);
  const manifestPath = path.join(resolvedInputDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Migration bundle manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  return {
    bundleRoot: resolvedInputDir,
    manifest,
    summary: formatMigrationSummary(manifest, resolvedInputDir),
  };
}

function formatBoolLabel(value) {
  return value ? "yes" : "no";
}

function formatMigrationSummary(manifest, bundleRoot = "") {
  const users = Object.values(manifest.users || {});
  const admins = users.filter((user) => Array.isArray(user.roles) && user.roles.includes("admin"));
  const disabled = users.filter((user) => user.enabled === false);
  const lines = [
    "*Multi-User Migration Bundle*",
    `Bundle: ${bundleRoot || "(unknown)"}`,
    `Exported: ${manifest.exportedAt || "(unknown)"}`,
    `Version: ${manifest.version ?? "(unknown)"}`,
    `Users: ${users.length}`,
    `Admins: ${admins.length}`,
    `Disabled users: ${disabled.length}`,
    `Default user: ${manifest.registries?.defaultUser || "-"}`,
    `Deleted users tracked: ${(manifest.registries?.deletedUsers || []).length}`,
    "",
    "*Preserved UX*",
    `Setup help snapshot: ${formatBoolLabel(typeof manifest.ux?.setupHelp === "string" && manifest.ux.setupHelp.trim())}`,
    `Admin help snapshot: ${formatBoolLabel(typeof manifest.ux?.adminHelp === "string" && manifest.ux.adminHelp.trim())}`,
    "",
    "*Shared Assets*",
    `Admin audit log: ${formatBoolLabel(!!manifest.shared?.adminAuditLog)}`,
    `Pending runs: ${formatBoolLabel(!!manifest.shared?.pendingRuns)}`,
    `Gateway state: ${formatBoolLabel(!!manifest.shared?.gateway)}`,
    `Notification scripts: ${Object.entries(manifest.shared?.notificationScripts || {})
      .filter(([, present]) => present)
      .map(([name]) => name)
      .join(", ") || "-"}`,
    "",
    "*Users*",
  ];

  for (const user of users.sort((a, b) => String(a.slackDisplayName || a.slackUserId).localeCompare(String(b.slackDisplayName || b.slackUserId)))) {
    const credentials = Array.isArray(user.credentialKinds) ? user.credentialKinds.join(", ") : "-";
    const notifications = Object.entries(user.notificationInventory || {})
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(", ");
    const services = Object.entries(user.serviceInventory || {})
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(", ");
    lines.push(`- ${user.slackDisplayName || user.slackUserId} (${user.slackUserId})`);
    lines.push(`  sandbox=${user.sandboxName || "-"} enabled=${user.enabled !== false ? "yes" : "no"} roles=${(user.roles || []).join(",") || "-"}`);
    lines.push(`  credentials=${credentials || "-"}`);
    lines.push(`  notifications=${notifications || "-"}`);
    lines.push(`  services=${services || "-"}`);
  }

  return lines.join("\n");
}

module.exports = {
  BUNDLE_VERSION,
  exportMultiUserState,
  formatMigrationSummary,
  importMultiUserState,
  inspectMultiUserState,
  loadCurrentState,
  restoreAllUsersFromBundle,
  restoreUserFromBundle,
};
