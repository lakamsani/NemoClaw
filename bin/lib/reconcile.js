// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { ROOT } = require("./runner");
const userReg = require("./user-registry");
const { loadRuntimeConfig, resolveRepoRoot } = require("./runtime-config");
const { waitForSandboxReady } = require("./sandbox-lifecycle");

function resolveUserPath(repoRoot, value, fallback) {
  const raw = value || fallback;
  return path.isAbsolute(raw) ? path.resolve(raw) : path.join(repoRoot, raw);
}

function getUserReconcilePlan(slackUserId, { repoRoot = ROOT } = {}) {
  const user = userReg.getUser(slackUserId);
  if (!user) {
    throw new Error(`User ${slackUserId} not found in registry.`);
  }
  const resolvedRepoRoot = resolveRepoRoot(repoRoot);
  const credentialsDir = resolveUserPath(
    resolvedRepoRoot,
    user.credentialsDir,
    `persist/users/${slackUserId}/credentials`,
  );
  const workspaceDir = resolveUserPath(
    resolvedRepoRoot,
    user.personalityDir,
    `persist/users/${slackUserId}/workspace`,
  );
  const injectScript = path.join(resolvedRepoRoot, "scripts", "inject-user-credentials.sh");
  const plan = {
    slackUserId,
    slackDisplayName: user.slackDisplayName || slackUserId,
    sandboxName: user.sandboxName,
    githubUser: user.githubUser || "",
    enabled: user.enabled !== false,
    credentialsDir,
    workspaceDir,
    injectScript,
    credentialsDirExists: fs.existsSync(credentialsDir),
    workspaceDirExists: fs.existsSync(workspaceDir),
    steps: [
      `Inject credentials into sandbox '${user.sandboxName}' from '${credentialsDir}'`,
      `Preserve workspace at '${workspaceDir}'`,
    ],
  };
  return plan;
}

function formatReconcilePlan(plan) {
  return [
    `User: ${plan.slackDisplayName} (${plan.slackUserId})`,
    `Sandbox: ${plan.sandboxName}`,
    `Enabled: ${plan.enabled ? "yes" : "no"}`,
    `Credentials: ${plan.credentialsDir} ${plan.credentialsDirExists ? "" : "(missing)"}`.trim(),
    `Workspace: ${plan.workspaceDir} ${plan.workspaceDirExists ? "" : "(missing)"}`.trim(),
    `GitHub: ${plan.githubUser || "-"}`,
    `Steps: ${plan.steps.join("; ")}`,
  ].join("\n");
}

function reconcileUser(slackUserId, { repoRoot = ROOT, dryRun = false } = {}) {
  const plan = getUserReconcilePlan(slackUserId, { repoRoot });
  if (dryRun) {
    return { ok: true, dryRun: true, plan };
  }
  const config = loadRuntimeConfig(repoRoot);
  const ready = waitForSandboxReady(plan.sandboxName, { repoRoot });
  if (!ready) {
    throw new Error(`Sandbox '${plan.sandboxName}' is not Ready; refusing to inject credentials.`);
  }
  execFileSync(
    "bash",
    [
      plan.injectScript,
      plan.sandboxName,
      plan.credentialsDir,
      "--slack-user-id",
      plan.slackUserId,
      ...(plan.githubUser ? ["--github-user", plan.githubUser] : []),
    ],
    {
      cwd: resolveRepoRoot(repoRoot),
      stdio: "pipe",
      encoding: "utf-8",
      timeout: config.reconcile.injectTimeoutMs,
    },
  );
  return { ok: true, dryRun: false, plan };
}

function reconcileAll({ repoRoot = ROOT, dryRun = false, includeDisabled = false } = {}) {
  const { users } = userReg.listUsers();
  const selected = users.filter((user) => includeDisabled || user.enabled !== false);
  const results = [];
  for (const user of selected) {
    results.push(reconcileUser(user.slackUserId, { repoRoot, dryRun }));
  }
  return results;
}

module.exports = {
  formatReconcilePlan,
  getUserReconcilePlan,
  reconcileAll,
  reconcileUser,
};
