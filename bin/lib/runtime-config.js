// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");

const { ROOT } = require("./runner");

const DEFAULT_RUNTIME_CONFIG = {
  sandbox: {
    createTimeoutMs: 300000,
    readyTimeoutMs: 180000,
    readyPollMs: 5000,
    postCreateRecoveryTimeoutMs: 90000,
  },
  reconcile: {
    injectTimeoutMs: 120000,
  },
  resilience: {
    devtoolsTimeoutSeconds: 90,
  },
  policies: {
    defaultPresets: ["npm", "pypi", "slack"],
    conditionalPresets: [
      { preset: "freshworks", credential: "freshrelease-api-key.txt" },
    ],
  },
  workspace: {
    sharedDefaultsDir: "persist/workspace",
    sharedFiles: [
      "SOUL.md",
      "IDENTITY.md",
      "USER.md",
      "TOOLS.md",
      "HEARTBEAT.md",
      "AGENTS.md",
      "session-artifacts.json",
      "scripts/session_artifacts.py",
      "BOOTSTRAP.md",
    ],
  },
  tools: {
    priorityOrder: [
      "Direct APIs",
      "Native CLIs",
      "Local helper scripts",
      "Skills or plugins",
      "Claude Code for real coding tasks",
    ],
  },
};

function resolveRepoRoot(repoRoot = ROOT) {
  return path.resolve(repoRoot);
}

function mergeValue(base, override) {
  if (Array.isArray(base)) {
    return Array.isArray(override) ? [...override] : [...base];
  }
  if (base && typeof base === "object") {
    const next = { ...base };
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      return next;
    }
    for (const [key, value] of Object.entries(override)) {
      next[key] = key in base ? mergeValue(base[key], value) : value;
    }
    return next;
  }
  return override === undefined ? base : override;
}

function loadRuntimeConfig(repoRoot = ROOT) {
  const resolvedRepoRoot = resolveRepoRoot(repoRoot);
  const configPath = path.join(resolvedRepoRoot, "config", "multi-user", "runtime.json");
  if (!fs.existsSync(configPath)) {
    return mergeValue(DEFAULT_RUNTIME_CONFIG, {});
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  return mergeValue(DEFAULT_RUNTIME_CONFIG, raw);
}

function getSharedWorkspaceDir(repoRoot = ROOT) {
  const config = loadRuntimeConfig(repoRoot);
  return path.join(resolveRepoRoot(repoRoot), config.workspace.sharedDefaultsDir);
}

function copySharedWorkspaceFiles(repoRoot, workspaceDir, { overwrite = false } = {}) {
  const config = loadRuntimeConfig(repoRoot);
  const sharedDir = getSharedWorkspaceDir(repoRoot);
  if (!fs.existsSync(sharedDir)) return [];
  const copied = [];
  for (const file of config.workspace.sharedFiles) {
    const src = path.join(sharedDir, file);
    const dst = path.join(workspaceDir, file);
    if (!fs.existsSync(src)) continue;
    if (!overwrite && fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied.push(file);
  }
  return copied;
}

module.exports = {
  DEFAULT_RUNTIME_CONFIG,
  copySharedWorkspaceFiles,
  getSharedWorkspaceDir,
  loadRuntimeConfig,
  resolveRepoRoot,
};
