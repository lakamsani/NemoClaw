// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { ROOT } = require("./runner");
const registry = require("./registry");
const userReg = require("./user-registry");
const policies = require("./policies");
const { createSandboxWithRecovery } = require("./sandbox-lifecycle");
const { copySharedWorkspaceFiles, loadRuntimeConfig, resolveRepoRoot } = require("./runtime-config");

const runtimeConfig = loadRuntimeConfig(ROOT);
const DEFAULT_POLICY_PRESETS = runtimeConfig.policies.defaultPresets;
const CONDITIONAL_POLICY_PRESETS = runtimeConfig.policies.conditionalPresets;

function resolveUserPath(repoRoot, value, fallback) {
  const raw = value || fallback;
  return path.isAbsolute(raw) ? path.resolve(raw) : path.join(repoRoot, raw);
}

function ensureDir(dirPath, mode = 0o700) {
  fs.mkdirSync(dirPath, { recursive: true, mode });
}

function getLiveSandboxNames() {
  try {
    const raw = execFileSync("openshell", ["sandbox", "list"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const names = new Set();
    for (const line of String(raw || "").split("\n")) {
      const trimmed = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (!trimmed || trimmed.startsWith("NAME ")) continue;
      const parts = trimmed.split(/\s+/);
      if (parts[0]) names.add(parts[0]);
    }
    return names;
  } catch {
    return new Set();
  }
}

function ensureSandboxRegistryEntry(sandboxName) {
  if (registry.getSandbox(sandboxName)) return false;
  registry.registerSandbox({
    name: sandboxName,
    model: "anthropic/claude-sonnet-4-6",
    provider: "openshell",
    gpuEnabled: false,
    policies: [],
  });
  return true;
}

function applyDefaultPolicies(sandboxName, selectedPresets = DEFAULT_POLICY_PRESETS) {
  const applied = [];
  for (const preset of selectedPresets) {
    try {
      policies.applyPreset(sandboxName, preset);
      applied.push(preset);
    } catch {
      /* ignored */
    }
  }
  return applied;
}

function getConditionalPolicies(credentialsDir) {
  if (!credentialsDir || !fs.existsSync(credentialsDir)) return [];
  return CONDITIONAL_POLICY_PRESETS
    .filter(({ credential }) => fs.existsSync(path.join(credentialsDir, credential)))
    .map(({ preset }) => preset);
}

function getBootstrapPlan(slackUserId, { repoRoot = ROOT } = {}) {
  const user = userReg.getUser(slackUserId);
  if (!user) throw new Error(`User ${slackUserId} not found in registry.`);
  const resolvedRepoRoot = resolveRepoRoot(repoRoot);
  const liveSandboxes = getLiveSandboxNames();
  const workspaceDir = resolveUserPath(
    resolvedRepoRoot,
    user.personalityDir,
    `persist/users/${slackUserId}/workspace`,
  );
  const credentialsDir = resolveUserPath(
    resolvedRepoRoot,
    user.credentialsDir,
    `persist/users/${slackUserId}/credentials`,
  );
  const registrySandbox = registry.getSandbox(user.sandboxName);
  return {
    slackUserId,
    slackDisplayName: user.slackDisplayName || slackUserId,
    sandboxName: user.sandboxName,
    githubUser: user.githubUser || "",
    enabled: user.enabled !== false,
    workspaceDir,
    credentialsDir,
    hasWorkspaceDir: fs.existsSync(workspaceDir),
    hasCredentialsDir: fs.existsSync(credentialsDir),
    sandboxInRegistry: !!registrySandbox,
    sandboxLive: liveSandboxes.has(user.sandboxName),
    defaultPolicies: [...DEFAULT_POLICY_PRESETS, ...getConditionalPolicies(credentialsDir)],
  };
}

function formatBootstrapPlan(plan) {
  return [
    `User: ${plan.slackDisplayName} (${plan.slackUserId})`,
    `Sandbox: ${plan.sandboxName}`,
    `Enabled: ${plan.enabled ? "yes" : "no"}`,
    `Workspace: ${plan.workspaceDir} ${plan.hasWorkspaceDir ? "" : "(missing)"}`.trim(),
    `Credentials: ${plan.credentialsDir} ${plan.hasCredentialsDir ? "" : "(missing)"}`.trim(),
    `Sandbox live: ${plan.sandboxLive ? "yes" : "no"}`,
    `Sandbox in registry: ${plan.sandboxInRegistry ? "yes" : "no"}`,
    `Default policies: ${plan.defaultPolicies.join(", ")}`,
  ].join("\n");
}

function bootstrapUser(slackUserId, { repoRoot = ROOT, dryRun = false } = {}) {
  const plan = getBootstrapPlan(slackUserId, { repoRoot });
  if (dryRun) return { ok: true, dryRun: true, plan, copiedWorkspaceFiles: [], appliedPolicies: [] };

  ensureDir(plan.credentialsDir, 0o700);
  ensureDir(plan.workspaceDir, 0o755);
  const copiedWorkspaceFiles = copySharedWorkspaceFiles(resolveRepoRoot(repoRoot), plan.workspaceDir);

  if (!plan.sandboxLive) {
    createSandboxWithRecovery(plan.sandboxName, {
      repoRoot: resolveRepoRoot(repoRoot),
      stdio: "inherit",
    });
  }

  ensureSandboxRegistryEntry(plan.sandboxName);
  const appliedPolicies = applyDefaultPolicies(plan.sandboxName, plan.defaultPolicies);

  return { ok: true, dryRun: false, plan: getBootstrapPlan(slackUserId, { repoRoot }), copiedWorkspaceFiles, appliedPolicies };
}

function bootstrapAll({ repoRoot = ROOT, dryRun = false, includeDisabled = false } = {}) {
  const { users } = userReg.listUsers();
  const selected = users.filter((user) => includeDisabled || user.enabled !== false);
  return selected.map((user) => bootstrapUser(user.slackUserId, { repoRoot, dryRun }));
}

module.exports = {
  CONDITIONAL_POLICY_PRESETS,
  DEFAULT_POLICY_PRESETS,
  bootstrapAll,
  bootstrapUser,
  formatBootstrapPlan,
  getConditionalPolicies,
  getBootstrapPlan,
};
