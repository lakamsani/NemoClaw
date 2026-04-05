// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const { ROOT } = require("./runner");
const { loadRuntimeConfig } = require("./runtime-config");

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function parseSandboxList(raw) {
  const sandboxes = [];
  for (const line of stripAnsi(raw).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("NAME ")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 3) {
      sandboxes.push({
        name: parts[0],
        createdAt: `${parts[1]} ${parts[2]}`,
        phase: parts[3] || "",
      });
    }
  }
  return sandboxes;
}

function getLiveSandboxMap() {
  try {
    const raw = execFileSync("openshell", ["sandbox", "list"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Map(parseSandboxList(raw).map((item) => [item.name, item]));
  } catch {
    return new Map();
  }
}

function isSandboxReady(sandboxName) {
  return getLiveSandboxMap().get(sandboxName)?.phase === "Ready";
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForSandboxReady(sandboxName, {
  timeoutMs,
  pollMs,
  repoRoot = ROOT,
} = {}) {
  const config = loadRuntimeConfig(repoRoot);
  const effectiveTimeoutMs = timeoutMs ?? config.sandbox.readyTimeoutMs;
  const effectivePollMs = pollMs ?? config.sandbox.readyPollMs;
  const start = Date.now();
  while (Date.now() - start <= effectiveTimeoutMs) {
    if (isSandboxReady(sandboxName)) {
      return true;
    }
    sleep(effectivePollMs);
  }
  return isSandboxReady(sandboxName);
}

function stageBuildContext(repoRoot = ROOT) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
  fs.copyFileSync(path.join(resolvedRepoRoot, "Dockerfile"), path.join(buildCtx, "Dockerfile"));
  execFileSync("cp", ["-r", path.join(resolvedRepoRoot, "nemoclaw"), path.join(buildCtx, "nemoclaw")], { stdio: "ignore" });
  execFileSync("cp", ["-r", path.join(resolvedRepoRoot, "nemoclaw-blueprint"), path.join(buildCtx, "nemoclaw-blueprint")], { stdio: "ignore" });
  execFileSync("cp", ["-r", path.join(resolvedRepoRoot, "scripts"), path.join(buildCtx, "scripts")], { stdio: "ignore" });
  execFileSync("rm", ["-rf", path.join(buildCtx, "nemoclaw", "node_modules")], { stdio: "ignore" });
  return buildCtx;
}

function cleanupBuildContext(buildCtx) {
  try {
    execFileSync("rm", ["-rf", buildCtx], { stdio: "ignore" });
  } catch {
    /* ignored */
  }
}

function buildSandboxCreateArgs(repoRoot, sandboxName) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const buildCtx = stageBuildContext(resolvedRepoRoot);
  const basePolicyPath = path.join(resolvedRepoRoot, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
  const envArgs = [];
  if (process.env.NVIDIA_API_KEY) envArgs.push(`NVIDIA_API_KEY=${process.env.NVIDIA_API_KEY}`);
  return {
    buildCtx,
    args: [
      "sandbox",
      "create",
      "--from",
      path.join(buildCtx, "Dockerfile"),
      "--name",
      sandboxName,
      "--policy",
      basePolicyPath,
      "--",
      "env",
      ...envArgs,
      "nemoclaw-start",
    ],
  };
}

function createSandboxWithRecovery(sandboxName, {
  repoRoot = ROOT,
  stdio = "inherit",
} = {}) {
  const config = loadRuntimeConfig(repoRoot);
  const { buildCtx, args } = buildSandboxCreateArgs(repoRoot, sandboxName);
  let recovered = false;
  try {
    execFileSync("openshell", args, {
      cwd: path.resolve(repoRoot),
      stdio,
      timeout: config.sandbox.createTimeoutMs,
    });
  } catch (err) {
    recovered = waitForSandboxReady(sandboxName, {
      timeoutMs: config.sandbox.postCreateRecoveryTimeoutMs,
      pollMs: config.sandbox.readyPollMs,
      repoRoot,
    });
    if (!recovered) {
      const detail = err?.message || String(err);
      throw new Error(`Sandbox create did not reach Ready state for '${sandboxName}': ${detail}`);
    }
  } finally {
    cleanupBuildContext(buildCtx);
  }
  if (!recovered) {
    const ready = waitForSandboxReady(sandboxName, { repoRoot });
    if (!ready) {
      throw new Error(`Sandbox '${sandboxName}' was created but did not become Ready in time.`);
    }
  }
  return { ok: true, recovered };
}

module.exports = {
  buildSandboxCreateArgs,
  createSandboxWithRecovery,
  getLiveSandboxMap,
  isSandboxReady,
  parseSandboxList,
  waitForSandboxReady,
};
