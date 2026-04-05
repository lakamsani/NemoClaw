#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execFileSync, execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ---------------------------------------------------------------------------
// Color / style — respects NO_COLOR and non-TTY environments.
// Uses exact NVIDIA green #76B900 on truecolor terminals; 256-color otherwise.
// ---------------------------------------------------------------------------
const _useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const _tc =
  _useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");
const G = _useColor ? (_tc ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
const B = _useColor ? "\x1b[1m" : "";
const D = _useColor ? "\x1b[2m" : "";
const R = _useColor ? "\x1b[0m" : "";
const _RD = _useColor ? "\x1b[1;31m" : "";
const YW = _useColor ? "\x1b[1;33m" : "";

const {
  ROOT,
  SCRIPTS,
  run,
  runCapture: _runCapture,
  runInteractive,
  shellQuote,
  validateName,
} = require("./lib/runner");
const { resolveOpenshell } = require("./lib/resolve-openshell");
const { startGatewayForRecovery, pruneStaleSandboxEntry } = require("./lib/onboard");
const {
  ensureApiKey,
  ensureGithubToken,
  getCredential,
  isRepoPrivate,
} = require("./lib/credentials");
const registry = require("./lib/registry");
const userReg = require("./lib/user-registry");
const nim = require("./lib/nim");
const policies = require("./lib/policies");
const { parseGatewayInference } = require("./lib/inference-config");
const { getVersion } = require("./lib/version");
const {
  exportMultiUserState,
  importMultiUserState,
  inspectMultiUserState,
  restoreAllUsersFromBundle,
  restoreUserFromBundle,
} = require("./lib/migration");
const {
  formatReconcilePlan,
  reconcileAll,
  reconcileUser,
} = require("./lib/reconcile");
const {
  bootstrapAll,
  bootstrapUser,
  formatBootstrapPlan,
} = require("./lib/bootstrap");
const { copySharedWorkspaceFiles, loadRuntimeConfig } = require("./lib/runtime-config");
const { createSandboxWithRecovery } = require("./lib/sandbox-lifecycle");
const onboardSession = require("./lib/onboard-session");
const { parseLiveSandboxNames } = require("./lib/runtime-recovery");
const { NOTICE_ACCEPT_ENV, NOTICE_ACCEPT_FLAG } = require("./lib/usage-notice");

// ── Global commands ──────────────────────────────────────────────

const GLOBAL_COMMANDS = new Set([
  "onboard",
  "list",
  "deploy",
  "setup",
  "setup-spark",
  "start",
  "stop",
  "status",
  "debug",
  "uninstall",
  "user-add",
  "user-remove",
  "user-purge",
  "user-list",
  "user-status",
  "user-enable",
  "user-disable",
  "user-grant-admin",
  "user-revoke-admin",
  "migration-export",
  "migration-import",
  "migration-inspect",
  "migration-restore-user",
  "migration-restore-all",
  "bootstrap-user",
  "bootstrap-all",
  "reconcile-user",
  "reconcile-all",
  "help",
  "--help",
  "-h",
  "--version",
  "-v",
]);

const REMOTE_UNINSTALL_URL =
  "https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh";
let OPENSHELL_BIN = null;
const MIN_LOGS_OPENSHELL_VERSION = "0.0.7";
const NEMOCLAW_GATEWAY_NAME = "nemoclaw";
const DASHBOARD_FORWARD_PORT = "18789";

function getOpenshellBinary() {
  if (!OPENSHELL_BIN) {
    OPENSHELL_BIN = resolveOpenshell();
  }
  if (!OPENSHELL_BIN) {
    console.error("openshell CLI not found. Install OpenShell before using sandbox commands.");
    process.exit(1);
  }
  return OPENSHELL_BIN;
}

function runOpenshell(args, opts = {}) {
  const result = spawnSync(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    encoding: "utf-8",
    stdio: opts.stdio ?? "inherit",
  });
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(`  Command failed (exit ${result.status}): openshell ${args.join(" ")}`);
    process.exit(result.status || 1);
  }
  return result;
}

function captureOpenshell(args, opts = {}) {
  const result = spawnSync(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout || ""}${opts.ignoreError ? "" : result.stderr || ""}`.trim(),
  };
}

function cleanupGatewayAfterLastSandbox() {
  runOpenshell(["forward", "stop", DASHBOARD_FORWARD_PORT], { ignoreError: true });
  runOpenshell(["gateway", "destroy", "-g", NEMOCLAW_GATEWAY_NAME], { ignoreError: true });
  run(
    `docker volume ls -q --filter "name=openshell-cluster-${NEMOCLAW_GATEWAY_NAME}" | grep . && docker volume ls -q --filter "name=openshell-cluster-${NEMOCLAW_GATEWAY_NAME}" | xargs docker volume rm || true`,
    { ignoreError: true },
  );
}

function hasNoLiveSandboxes() {
  const liveList = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  if (liveList.status !== 0) {
    return false;
  }
  return parseLiveSandboxNames(liveList.output).size === 0;
}

function isMissingSandboxDeleteResult(output = "") {
  return /\bNotFound\b|\bNot Found\b|sandbox not found|sandbox .* not found|sandbox .* not present|sandbox does not exist|no such sandbox/i.test(
    stripAnsi(output),
  );
}

function getSandboxDeleteOutcome(deleteResult) {
  const output = `${deleteResult.stdout || ""}${deleteResult.stderr || ""}`.trim();
  return {
    output,
    alreadyGone: deleteResult.status !== 0 && isMissingSandboxDeleteResult(output),
  };
}

function parseVersionFromText(value = "") {
  const match = String(value || "").match(/([0-9]+\.[0-9]+\.[0-9]+)/);
  return match ? match[1] : null;
}

function versionGte(left = "0.0.0", right = "0.0.0") {
  const lhs = String(left)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const rhs = String(right)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(lhs.length, rhs.length);
  for (let index = 0; index < length; index += 1) {
    const a = lhs[index] || 0;
    const b = rhs[index] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function getInstalledOpenshellVersion() {
  const versionResult = captureOpenshell(["--version"], { ignoreError: true });
  return parseVersionFromText(versionResult.output);
}

function stripAnsi(value = "") {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/\x1b\[[0-9;]*m/g, "");
}

function buildRecoveredSandboxEntry(name, metadata = {}) {
  return {
    name,
    model: metadata.model || null,
    provider: metadata.provider || null,
    gpuEnabled: metadata.gpuEnabled === true,
    policies: Array.isArray(metadata.policies)
      ? metadata.policies
      : Array.isArray(metadata.policyPresets)
        ? metadata.policyPresets
        : [],
    nimContainer: metadata.nimContainer || null,
  };
}

function upsertRecoveredSandbox(name, metadata = {}) {
  let validName;
  try {
    validName = validateName(name, "sandbox name");
  } catch {
    return false;
  }

  const entry = buildRecoveredSandboxEntry(validName, metadata);
  if (registry.getSandbox(validName)) {
    registry.updateSandbox(validName, entry);
    return false;
  }
  registry.registerSandbox(entry);
  return true;
}

function shouldRecoverRegistryEntries(current, session, requestedSandboxName) {
  const hasSessionSandbox = Boolean(session?.sandboxName);
  const missingSessionSandbox =
    hasSessionSandbox && !current.sandboxes.some((sandbox) => sandbox.name === session.sandboxName);
  const missingRequestedSandbox =
    Boolean(requestedSandboxName) &&
    !current.sandboxes.some((sandbox) => sandbox.name === requestedSandboxName);
  const hasRecoverySeed =
    current.sandboxes.length > 0 || hasSessionSandbox || Boolean(requestedSandboxName);
  return {
    missingRequestedSandbox,
    shouldRecover:
      hasRecoverySeed &&
      (current.sandboxes.length === 0 || missingRequestedSandbox || missingSessionSandbox),
  };
}

function seedRecoveryMetadata(current, session, requestedSandboxName) {
  const metadataByName = new Map(current.sandboxes.map((sandbox) => [sandbox.name, sandbox]));
  let recoveredFromSession = false;

  if (!session?.sandboxName) {
    return { metadataByName, recoveredFromSession };
  }

  metadataByName.set(
    session.sandboxName,
    buildRecoveredSandboxEntry(session.sandboxName, {
      model: session.model || null,
      provider: session.provider || null,
      nimContainer: session.nimContainer || null,
      policyPresets: session.policyPresets || null,
    }),
  );
  const sessionSandboxMissing = !current.sandboxes.some(
    (sandbox) => sandbox.name === session.sandboxName,
  );
  const shouldRecoverSessionSandbox =
    current.sandboxes.length === 0 ||
    sessionSandboxMissing ||
    requestedSandboxName === session.sandboxName;
  if (shouldRecoverSessionSandbox) {
    recoveredFromSession = upsertRecoveredSandbox(
      session.sandboxName,
      metadataByName.get(session.sandboxName),
    );
  }
  return { metadataByName, recoveredFromSession };
}

async function recoverRegistryFromLiveGateway(metadataByName) {
  if (!resolveOpenshell()) {
    return 0;
  }
  const recovery = await recoverNamedGatewayRuntime();
  const canInspectLiveGateway =
    recovery.recovered ||
    recovery.before?.state === "healthy_named" ||
    recovery.after?.state === "healthy_named";
  if (!canInspectLiveGateway) {
    return 0;
  }

  let recoveredFromGateway = 0;
  const liveList = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  const liveNames = Array.from(parseLiveSandboxNames(liveList.output));
  for (const name of liveNames) {
    const metadata = metadataByName.get(name) || {};
    if (upsertRecoveredSandbox(name, metadata)) {
      recoveredFromGateway += 1;
    }
  }
  return recoveredFromGateway;
}

function applyRecoveredDefault(currentDefaultSandbox, requestedSandboxName, session) {
  const recovered = registry.listSandboxes();
  const preferredDefault =
    requestedSandboxName || (!currentDefaultSandbox ? session?.sandboxName || null : null);
  if (
    preferredDefault &&
    recovered.sandboxes.some((sandbox) => sandbox.name === preferredDefault)
  ) {
    registry.setDefault(preferredDefault);
  }
  return registry.listSandboxes();
}

async function recoverRegistryEntries({ requestedSandboxName = null } = {}) {
  const current = registry.listSandboxes();
  const session = onboardSession.loadSession();
  const recoveryCheck = shouldRecoverRegistryEntries(current, session, requestedSandboxName);
  if (!recoveryCheck.shouldRecover) {
    return { ...current, recoveredFromSession: false, recoveredFromGateway: 0 };
  }

  const seeded = seedRecoveryMetadata(current, session, requestedSandboxName);
  const shouldProbeLiveGateway = current.sandboxes.length > 0 || Boolean(session?.sandboxName);
  const recoveredFromGateway = shouldProbeLiveGateway
    ? await recoverRegistryFromLiveGateway(seeded.metadataByName)
    : 0;
  const recovered = applyRecoveredDefault(current.defaultSandbox, requestedSandboxName, session);
  return {
    ...recovered,
    recoveredFromSession: seeded.recoveredFromSession,
    recoveredFromGateway,
  };
}

function hasNamedGateway(output = "") {
  return stripAnsi(output).includes("Gateway: nemoclaw");
}

function getActiveGatewayName(output = "") {
  const match = stripAnsi(output).match(/^\s*Gateway:\s+(.+?)\s*$/m);
  return match ? match[1].trim() : "";
}

function getNamedGatewayLifecycleState() {
  const status = captureOpenshell(["status"]);
  const gatewayInfo = captureOpenshell(["gateway", "info", "-g", "nemoclaw"]);
  const cleanStatus = stripAnsi(status.output);
  const activeGateway = getActiveGatewayName(status.output);
  const connected = /^\s*Status:\s*Connected\b/im.test(cleanStatus);
  const named = hasNamedGateway(gatewayInfo.output);
  const refusing = /Connection refused|client error \(Connect\)|tcp connect error/i.test(
    cleanStatus,
  );
  if (connected && activeGateway === "nemoclaw" && named) {
    return { state: "healthy_named", status: status.output, gatewayInfo: gatewayInfo.output };
  }
  if (activeGateway === "nemoclaw" && named && refusing) {
    return { state: "named_unreachable", status: status.output, gatewayInfo: gatewayInfo.output };
  }
  if (activeGateway === "nemoclaw" && named) {
    return { state: "named_unhealthy", status: status.output, gatewayInfo: gatewayInfo.output };
  }
  if (connected) {
    return { state: "connected_other", status: status.output, gatewayInfo: gatewayInfo.output };
  }
  return { state: "missing_named", status: status.output, gatewayInfo: gatewayInfo.output };
}

async function recoverNamedGatewayRuntime() {
  const before = getNamedGatewayLifecycleState();
  if (before.state === "healthy_named") {
    return { recovered: true, before, after: before, attempted: false };
  }

  runOpenshell(["gateway", "select", "nemoclaw"], { ignoreError: true });
  let after = getNamedGatewayLifecycleState();
  if (after.state === "healthy_named") {
    process.env.OPENSHELL_GATEWAY = "nemoclaw";
    return { recovered: true, before, after, attempted: true, via: "select" };
  }

  const shouldStartGateway = [before.state, after.state].some((state) =>
    ["missing_named", "named_unhealthy", "named_unreachable", "connected_other"].includes(state),
  );

  if (shouldStartGateway) {
    try {
      await startGatewayForRecovery();
    } catch {
      // Fall through to the lifecycle re-check below so we preserve the
      // existing recovery result shape and emit the correct classification.
    }
    runOpenshell(["gateway", "select", "nemoclaw"], { ignoreError: true });
    after = getNamedGatewayLifecycleState();
    if (after.state === "healthy_named") {
      process.env.OPENSHELL_GATEWAY = "nemoclaw";
      return { recovered: true, before, after, attempted: true, via: "start" };
    }
  }

  return { recovered: false, before, after, attempted: true };
}

function getSandboxGatewayState(sandboxName) {
  const result = captureOpenshell(["sandbox", "get", sandboxName]);
  const output = result.output;
  if (result.status === 0) {
    return { state: "present", output };
  }
  if (/\bNotFound\b|\bNot Found\b|sandbox not found/i.test(output)) {
    return { state: "missing", output };
  }
  if (
    /transport error|Connection refused|handshake verification failed|Missing gateway auth token|device identity required/i.test(
      output,
    )
  ) {
    return { state: "gateway_error", output };
  }
  return { state: "unknown_error", output };
}

function printGatewayLifecycleHint(output = "", sandboxName = "", writer = console.error) {
  const cleanOutput = stripAnsi(output);
  if (/No gateway configured/i.test(cleanOutput)) {
    writer(
      "  The selected NemoClaw gateway is no longer configured or its metadata/runtime has been lost.",
    );
    writer(
      "  Start the gateway again with `openshell gateway start --name nemoclaw` before expecting existing sandboxes to reconnect.",
    );
    writer(
      "  If the gateway has to be rebuilt from scratch, recreate the affected sandbox afterward.",
    );
    return;
  }
  if (
    /Connection refused|client error \(Connect\)|tcp connect error/i.test(cleanOutput) &&
    /Gateway:\s+nemoclaw/i.test(cleanOutput)
  ) {
    writer(
      "  The selected NemoClaw gateway exists in metadata, but its API is refusing connections after restart.",
    );
    writer("  This usually means the gateway runtime did not come back cleanly after the restart.");
    writer(
      "  Retry `openshell gateway start --name nemoclaw`; if it stays in this state, rebuild the gateway before expecting existing sandboxes to reconnect.",
    );
    return;
  }
  if (/handshake verification failed/i.test(cleanOutput)) {
    writer("  This looks like gateway identity drift after restart.");
    writer(
      "  Existing sandboxes may still be recorded locally, but the current gateway no longer trusts their prior connection state.",
    );
    writer(
      "  Try re-establishing the NemoClaw gateway/runtime first. If the sandbox is still unreachable, recreate just that sandbox with `nemoclaw onboard`.",
    );
    return;
  }
  if (/Connection refused|transport error/i.test(cleanOutput)) {
    writer(
      `  The sandbox '${sandboxName}' may still exist, but the current gateway/runtime is not reachable.`,
    );
    writer("  Check `openshell status`, verify the active gateway, and retry.");
    return;
  }
  if (/Missing gateway auth token|device identity required/i.test(cleanOutput)) {
    writer(
      "  The gateway is reachable, but the current auth or device identity state is not usable.",
    );
    writer("  Verify the active gateway and retry after re-establishing the runtime.");
  }
}

// eslint-disable-next-line complexity
async function getReconciledSandboxGatewayState(sandboxName) {
  let lookup = getSandboxGatewayState(sandboxName);
  if (lookup.state === "present") {
    return lookup;
  }
  if (lookup.state === "missing") {
    return lookup;
  }

  if (lookup.state === "gateway_error") {
    const recovery = await recoverNamedGatewayRuntime();
    if (recovery.recovered) {
      const retried = getSandboxGatewayState(sandboxName);
      if (retried.state === "present" || retried.state === "missing") {
        return { ...retried, recoveredGateway: true, recoveryVia: recovery.via || null };
      }
      if (/handshake verification failed/i.test(retried.output)) {
        return {
          state: "identity_drift",
          output: retried.output,
          recoveredGateway: true,
          recoveryVia: recovery.via || null,
        };
      }
      return { ...retried, recoveredGateway: true, recoveryVia: recovery.via || null };
    }
    const latestLifecycle = getNamedGatewayLifecycleState();
    const latestStatus = stripAnsi(latestLifecycle.status || "");
    if (/No gateway configured/i.test(latestStatus)) {
      return {
        state: "gateway_missing_after_restart",
        output: latestLifecycle.status || lookup.output,
      };
    }
    if (
      /Connection refused|client error \(Connect\)|tcp connect error/i.test(latestStatus) &&
      /Gateway:\s+nemoclaw/i.test(latestStatus)
    ) {
      return {
        state: "gateway_unreachable_after_restart",
        output: latestLifecycle.status || lookup.output,
      };
    }
    if (
      recovery.after?.state === "named_unreachable" ||
      recovery.before?.state === "named_unreachable"
    ) {
      return {
        state: "gateway_unreachable_after_restart",
        output: recovery.after?.status || recovery.before?.status || lookup.output,
      };
    }
    return { ...lookup, gatewayRecoveryFailed: true };
  }

  return lookup;
}

async function ensureLiveSandboxOrExit(sandboxName) {
  const lookup = await getReconciledSandboxGatewayState(sandboxName);
  if (lookup.state === "present") {
    return lookup;
  }
  if (lookup.state === "missing") {
    registry.removeSandbox(sandboxName);
    console.error(`  Sandbox '${sandboxName}' is not present in the live OpenShell gateway.`);
    console.error("  Removed stale local registry entry.");
    console.error(
      "  Run `nemoclaw list` to confirm the remaining sandboxes, or `nemoclaw onboard` to create a new one.",
    );
    process.exit(1);
  }
  if (lookup.state === "identity_drift") {
    console.error(
      `  Sandbox '${sandboxName}' is recorded locally, but the gateway trust material rotated after restart.`,
    );
    if (lookup.output) {
      console.error(lookup.output);
    }
    console.error(
      "  Existing sandbox connections cannot be reattached safely after this gateway identity change.",
    );
    console.error(
      "  Recreate this sandbox with `nemoclaw onboard` once the gateway runtime is stable.",
    );
    process.exit(1);
  }
  if (lookup.state === "gateway_unreachable_after_restart") {
    console.error(
      `  Sandbox '${sandboxName}' may still exist, but the selected NemoClaw gateway is still refusing connections after restart.`,
    );
    if (lookup.output) {
      console.error(lookup.output);
    }
    console.error(
      "  Retry `openshell gateway start --name nemoclaw` and verify `openshell status` is healthy before reconnecting.",
    );
    console.error(
      "  If the gateway never becomes healthy, rebuild the gateway and then recreate the affected sandbox.",
    );
    process.exit(1);
  }
  if (lookup.state === "gateway_missing_after_restart") {
    console.error(
      `  Sandbox '${sandboxName}' may still exist locally, but the NemoClaw gateway is no longer configured after restart/rebuild.`,
    );
    if (lookup.output) {
      console.error(lookup.output);
    }
    console.error(
      "  Start the gateway again with `openshell gateway start --name nemoclaw` before retrying.",
    );
    console.error(
      "  If the gateway had to be rebuilt from scratch, recreate the affected sandbox afterward.",
    );
    process.exit(1);
  }
  console.error(`  Unable to verify sandbox '${sandboxName}' against the live OpenShell gateway.`);
  if (lookup.output) {
    console.error(lookup.output);
  }
  printGatewayLifecycleHint(lookup.output, sandboxName);
  console.error("  Check `openshell status` and the active gateway, then retry.");
  process.exit(1);
}

function printOldLogsCompatibilityGuidance(installedVersion = null) {
  const versionText = installedVersion ? ` (${installedVersion})` : "";
  console.error(
    `  Installed OpenShell${versionText} is too old or incompatible with \`nemoclaw logs\`.`,
  );
  console.error(`  NemoClaw expects \`openshell logs <name>\` and live streaming via \`--tail\`.`);
  console.error(
    "  Upgrade OpenShell by rerunning `nemoclaw onboard`, or reinstall the OpenShell CLI and try again.",
  );
}

function resolveUninstallScript() {
  const candidates = [path.join(ROOT, "uninstall.sh"), path.join(__dirname, "..", "uninstall.sh")];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function exitWithSpawnResult(result) {
  if (result.status !== null) {
    process.exit(result.status);
  }

  if (result.signal) {
    const signalNumber = os.constants.signals[result.signal];
    process.exit(signalNumber ? 128 + signalNumber : 1);
  }

  process.exit(1);
}

// ── Commands ─────────────────────────────────────────────────────

async function onboard(args) {
  const { onboard: runOnboard } = require("./lib/onboard");
  const allowedArgs = new Set(["--non-interactive", "--resume", NOTICE_ACCEPT_FLAG]);
  const unknownArgs = args.filter((arg) => !allowedArgs.has(arg));
  if (unknownArgs.length > 0) {
    console.error(`  Unknown onboard option(s): ${unknownArgs.join(", ")}`);
    console.error(
      `  Usage: nemoclaw onboard [--non-interactive] [--resume] [${NOTICE_ACCEPT_FLAG}]`,
    );
    process.exit(1);
  }
  const nonInteractive = args.includes("--non-interactive");
  const resume = args.includes("--resume");
  const acceptThirdPartySoftware =
    args.includes(NOTICE_ACCEPT_FLAG) || String(process.env[NOTICE_ACCEPT_ENV] || "") === "1";
  await runOnboard({ nonInteractive, resume, acceptThirdPartySoftware });
}

async function setup(args = []) {
  console.log("");
  console.log("  ⚠  `nemoclaw setup` is deprecated. Use `nemoclaw onboard` instead.");
  console.log("");
  await onboard(args);
}

async function setupSpark() {
  // setup-spark.sh configures Docker cgroups — it does not use NVIDIA_API_KEY.
  run(`sudo bash "${SCRIPTS}/setup-spark.sh"`);
}

// eslint-disable-next-line complexity
async function deploy(instanceName) {
  if (!instanceName) {
    console.error("  Usage: nemoclaw deploy <instance-name>");
    console.error("");
    console.error("  Examples:");
    console.error("    nemoclaw deploy my-gpu-box");
    console.error("    nemoclaw deploy nemoclaw-prod");
    console.error("    nemoclaw deploy nemoclaw-test");
    process.exit(1);
  }
  await ensureApiKey();
  if (isRepoPrivate("NVIDIA/OpenShell")) {
    await ensureGithubToken();
  }
  validateName(instanceName, "instance name");
  const name = instanceName;
  const qname = shellQuote(name);
  const gpu = process.env.NEMOCLAW_GPU || "a2-highgpu-1g:nvidia-tesla-a100:1";

  console.log("");
  console.log(`  Deploying NemoClaw to Brev instance: ${name}`);
  console.log("");

  try {
    execFileSync("which", ["brev"], { stdio: "ignore" });
  } catch {
    console.error("brev CLI not found. Install: https://brev.nvidia.com");
    process.exit(1);
  }

  let exists = false;
  try {
    const out = execFileSync("brev", ["ls"], { encoding: "utf-8" });
    exists = out.includes(name);
  } catch (err) {
    if (err.stdout && err.stdout.includes(name)) exists = true;
    if (err.stderr && err.stderr.includes(name)) exists = true;
  }

  if (!exists) {
    console.log(`  Creating Brev instance '${name}' (${gpu})...`);
    run(`brev create ${qname} --gpu ${shellQuote(gpu)}`);
  } else {
    console.log(`  Brev instance '${name}' already exists.`);
  }

  run(`brev refresh`, { ignoreError: true });

  process.stdout.write(`  Waiting for SSH `);
  for (let i = 0; i < 60; i++) {
    try {
      execFileSync(
        "ssh",
        ["-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", name, "echo", "ok"],
        { encoding: "utf-8", stdio: "ignore" },
      );
      process.stdout.write(` ${G}✓${R}\n`);
      break;
    } catch {
      if (i === 59) {
        process.stdout.write("\n");
        console.error(`  Timed out waiting for SSH to ${name}`);
        process.exit(1);
      }
      process.stdout.write(".");
      spawnSync("sleep", ["3"]);
    }
  }

  console.log("  Syncing NemoClaw to VM...");
  run(
    `ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'mkdir -p /home/ubuntu/nemoclaw'`,
  );
  run(
    `rsync -az --delete --exclude node_modules --exclude .git --exclude src -e "ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR" "${ROOT}/scripts" "${ROOT}/Dockerfile" "${ROOT}/nemoclaw" "${ROOT}/nemoclaw-blueprint" "${ROOT}/bin" "${ROOT}/package.json" ${qname}:/home/ubuntu/nemoclaw/`,
  );

  const envLines = [`NVIDIA_API_KEY=${shellQuote(process.env.NVIDIA_API_KEY || "")}`];
  const ghToken = process.env.GITHUB_TOKEN;
  if (ghToken) envLines.push(`GITHUB_TOKEN=${shellQuote(ghToken)}`);
  const tgToken = getCredential("TELEGRAM_BOT_TOKEN");
  if (tgToken) envLines.push(`TELEGRAM_BOT_TOKEN=${shellQuote(tgToken)}`);
  const discordToken = getCredential("DISCORD_BOT_TOKEN");
  if (discordToken) envLines.push(`DISCORD_BOT_TOKEN=${shellQuote(discordToken)}`);
  const slackToken = getCredential("SLACK_BOT_TOKEN");
  if (slackToken) envLines.push(`SLACK_BOT_TOKEN=${shellQuote(slackToken)}`);
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-"));
  const envTmp = path.join(envDir, "env");
  fs.writeFileSync(envTmp, envLines.join("\n") + "\n", { mode: 0o600 });
  try {
    run(
      `scp -q -o StrictHostKeyChecking=no -o LogLevel=ERROR ${shellQuote(envTmp)} ${qname}:/home/ubuntu/nemoclaw/.env`,
    );
    run(
      `ssh -q -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'chmod 600 /home/ubuntu/nemoclaw/.env'`,
    );
  } finally {
    try {
      fs.unlinkSync(envTmp);
    } catch {
      /* ignored */
    }
    try {
      fs.rmdirSync(envDir);
    } catch {
      /* ignored */
    }
  }

  console.log("  Running setup...");
  runInteractive(
    `ssh -t -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && bash scripts/brev-setup.sh'`,
  );

  if (tgToken) {
    console.log("  Starting services...");
    run(
      `ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && bash scripts/start-services.sh'`,
    );
  }

  console.log("");
  console.log("  Connecting to sandbox...");
  console.log("");
  runInteractive(
    `ssh -t -o StrictHostKeyChecking=no -o LogLevel=ERROR ${qname} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && openshell sandbox connect nemoclaw'`,
  );
}

async function start() {
  const { startAll } = require("./lib/services");
  const { defaultSandbox } = registry.listSandboxes();
  const safeName =
    defaultSandbox && /^[a-zA-Z0-9._-]+$/.test(defaultSandbox) ? defaultSandbox : null;
  await startAll({ sandboxName: safeName || undefined });
}

function stop() {
  const { stopAll } = require("./lib/services");
  const { defaultSandbox } = registry.listSandboxes();
  const safeName =
    defaultSandbox && /^[a-zA-Z0-9._-]+$/.test(defaultSandbox) ? defaultSandbox : null;
  stopAll({ sandboxName: safeName || undefined });
}

function debug(args) {
  const { runDebug } = require("./lib/debug");
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
      case "-h":
        console.log("Collect NemoClaw diagnostic information\n");
        console.log("Usage: nemoclaw debug [--quick] [--output FILE] [--sandbox NAME]\n");
        console.log("Options:");
        console.log("  --quick, -q        Only collect minimal diagnostics");
        console.log("  --output, -o FILE  Write a tarball to FILE");
        console.log("  --sandbox NAME     Target sandbox name");
        process.exit(0);
        break;
      case "--quick":
      case "-q":
        opts.quick = true;
        break;
      case "--output":
      case "-o":
        if (!args[i + 1] || args[i + 1].startsWith("-")) {
          console.error("Error: --output requires a file path argument");
          process.exit(1);
        }
        opts.output = args[++i];
        break;
      case "--sandbox":
        if (!args[i + 1] || args[i + 1].startsWith("-")) {
          console.error("Error: --sandbox requires a name argument");
          process.exit(1);
        }
        opts.sandboxName = args[++i];
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }
  if (!opts.sandboxName) {
    opts.sandboxName = registry.listSandboxes().defaultSandbox || undefined;
  }
  runDebug(opts);
}

function uninstall(args) {
  const localScript = resolveUninstallScript();
  if (localScript) {
    console.log(`  Running local uninstall script: ${localScript}`);
    const result = spawnSync("bash", [localScript, ...args], {
      stdio: "inherit",
      cwd: ROOT,
      env: process.env,
    });
    exitWithSpawnResult(result);
  }

  // Download to file before execution — prevents partial-download execution.
  // Upstream URL is a rolling release so SHA-256 pinning isn't practical.
  console.log(`  Local uninstall script not found; falling back to ${REMOTE_UNINSTALL_URL}`);
  const uninstallDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-"));
  const uninstallScript = path.join(uninstallDir, "uninstall.sh");
  let result;
  let downloadFailed = false;
  try {
    try {
      execFileSync("curl", ["-fsSL", REMOTE_UNINSTALL_URL, "-o", uninstallScript], {
        stdio: "inherit",
      });
    } catch {
      console.error(`  Failed to download uninstall script from ${REMOTE_UNINSTALL_URL}`);
      downloadFailed = true;
    }
    if (!downloadFailed) {
      result = spawnSync("bash", [uninstallScript, ...args], {
        stdio: "inherit",
        cwd: ROOT,
        env: process.env,
      });
    }
  } finally {
    fs.rmSync(uninstallDir, { recursive: true, force: true });
  }
  if (downloadFailed) process.exit(1);
  exitWithSpawnResult(result);
}

function showStatus() {
  // Show sandbox registry
  const { sandboxes, defaultSandbox } = registry.listSandboxes();
  if (sandboxes.length > 0) {
    const live = parseGatewayInference(
      captureOpenshell(["inference", "get"], { ignoreError: true }).output,
    );
    console.log("");
    console.log("  Sandboxes:");
    for (const sb of sandboxes) {
      const def = sb.name === defaultSandbox ? " *" : "";
      const model = (live && live.model) || sb.model;
      console.log(`    ${sb.name}${def}${model ? ` (${model})` : ""}`);
    }
    console.log("");
  }

  // Show service status
  const { showStatus: showServiceStatus } = require("./lib/services");
  showServiceStatus({ sandboxName: defaultSandbox || undefined });
}

async function listSandboxes() {
  const recovery = await recoverRegistryEntries();
  const { sandboxes, defaultSandbox } = recovery;
  if (sandboxes.length === 0) {
    console.log("");
    const session = onboardSession.loadSession();
    if (session?.sandboxName) {
      console.log(
        `  No sandboxes registered locally, but the last onboarded sandbox was '${session.sandboxName}'.`,
      );
      console.log(
        "  Retry `nemoclaw <name> connect` or `nemoclaw <name> status` once the gateway/runtime is healthy.",
      );
    } else {
      console.log("  No sandboxes registered. Run `nemoclaw onboard` to get started.");
    }
    console.log("");
    return;
  }

  // Build user-to-sandbox lookup
  const { users } = userReg.listUsers();
  const sandboxUserMap = {};
  for (const u of users) {
    sandboxUserMap[u.sandboxName] = u.slackDisplayName || u.slackUserId;
  }

  // Query live gateway inference once; prefer it over stale registry values.
  const live = parseGatewayInference(
    captureOpenshell(["inference", "get"], { ignoreError: true }).output,
  );

  console.log("");
  if (recovery.recoveredFromSession) {
    console.log("  Recovered sandbox inventory from the last onboard session.");
    console.log("");
  }
  if (recovery.recoveredFromGateway > 0) {
    console.log(
      `  Recovered ${recovery.recoveredFromGateway} sandbox entr${recovery.recoveredFromGateway === 1 ? "y" : "ies"} from the live OpenShell gateway.`,
    );
    console.log("");
  }
  console.log("  Sandboxes:");
  for (const sb of sandboxes) {
    const def = sb.name === defaultSandbox ? " *" : "";
    const owner = sandboxUserMap[sb.name] || "-";
    const model = (live && live.model) || sb.model || "unknown";
    const provider = (live && live.provider) || sb.provider || "unknown";
    const gpu = sb.gpuEnabled ? "GPU" : "CPU";
    const presets = sb.policies && sb.policies.length > 0 ? sb.policies.join(", ") : "none";
    console.log(`    ${owner.padEnd(12)} ${sb.name}${def}`);
    console.log(`${"".padEnd(17)}model: ${model}  provider: ${provider}  ${gpu}  policies: ${presets}`);
  }
  console.log("");
  console.log("  * = default sandbox");
  console.log("");
}

// ── User lifecycle commands ──────────────────────────────────────

async function userAdd(args = []) {
  const { prompt: askPrompt } = require("./lib/credentials");
  const cleanupProvisioningArtifacts = (slackUserId, sandboxName, persistBase, createdUser, createdSandboxRegistryEntry) => {
    if (createdSandboxRegistryEntry) {
      try {
        registry.removeSandbox(sandboxName);
      } catch {
        /* ignored */
      }
    }
    if (createdUser) {
      try {
        userReg.removeUser(slackUserId);
      } catch {
        /* ignored */
      }
    }
    if (persistBase) {
      try {
        fs.rmSync(path.join(ROOT, persistBase), { recursive: true, force: true });
      } catch {
        /* ignored */
      }
    }
  };
  const applyDefaultPolicies = async (sandboxNameForPolicies) => {
    const defaultPresets = ["npm", "pypi", "slack"];
    const allPresets = policies.listPresets();
    const knownNames = new Set(allPresets.map((p) => p.name));

    console.log("");
    console.log("  Available policy presets:");
    allPresets.forEach((p) => {
      const suggested = defaultPresets.includes(p.name) ? " (default)" : "";
      console.log(`    ○ ${p.name} — ${p.description}${suggested}`);
    });
    console.log("");

    let selectedPresets = defaultPresets;
    if (nonInteractive) {
      console.log(`  [non-interactive] Applying default presets: ${defaultPresets.join(", ")}`);
    } else {
      const presetAnswer = await askPrompt(`  Apply default presets (${defaultPresets.join(", ")})? [Y/n/list]: `);

      if (presetAnswer.toLowerCase() === "n") {
        selectedPresets = [];
        console.log("  Skipping policy presets.");
      } else if (presetAnswer.toLowerCase() === "list") {
        const picks = await askPrompt("  Enter preset names (comma-separated): ");
        selectedPresets = picks.split(",").map((s) => s.trim()).filter(Boolean);
        const invalid = selectedPresets.filter((n) => !knownNames.has(n));
        if (invalid.length > 0) {
          console.error(`  Unknown preset(s): ${invalid.join(", ")} — skipping those.`);
          selectedPresets = selectedPresets.filter((n) => knownNames.has(n));
        }
      }
    }

    for (const preset of selectedPresets) {
      try {
        policies.applyPreset(sandboxNameForPolicies, preset);
      } catch (err) {
        console.error(`  Warning: failed to apply preset '${preset}': ${err.message}`);
      }
    }
    if (selectedPresets.length > 0) {
      console.log(`  Applied presets: ${selectedPresets.join(", ")}`);
    }
  };

  // Parse --non-interactive mode with named args
  const nonInteractive = args.includes("--non-interactive");
  const argAdmin = args.includes("--admin");
  let argSlackId, argDisplayName, argClawName, argGithubUser;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--slack-id":      argSlackId = args[++i]; break;
      case "--display-name":  argDisplayName = args[++i]; break;
      case "--claw-name":     argClawName = args[++i]; break;
      case "--github-user":   argGithubUser = args[++i]; break;
    }
  }

  if (nonInteractive && (!argSlackId || !argDisplayName || !argClawName)) {
    console.error("  Usage: nemoclaw user-add --non-interactive --slack-id <ID> --display-name <NAME> --claw-name <NAME> [--github-user <USER>] [--admin]");
    process.exit(1);
  }

  console.log("");
  console.log("  NemoClaw — Register a new user");
  console.log("");

  const slackUserId = nonInteractive ? argSlackId : await askPrompt("  Slack user ID (e.g. U09R681EPQ9): ");
  if (!slackUserId || !/^U[A-Z0-9]+$/.test(slackUserId)) {
    console.error("  Invalid Slack user ID. Must start with U followed by alphanumeric characters.");
    process.exit(1);
  }

  const existing = userReg.getUser(slackUserId);
  if (existing) {
    console.error(`  User ${slackUserId} already registered (sandbox: ${existing.sandboxName}).`);
    console.error("  Run 'nemoclaw user-remove " + slackUserId + "' first to re-register.");
    process.exit(1);
  }

  const slackDisplayName = nonInteractive ? argDisplayName : await askPrompt("  Slack display name: ");
  const sandboxName = nonInteractive ? argClawName : await askPrompt("  Sandbox name (e.g. alice-claw): ");
  if (!sandboxName || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(sandboxName)) {
    console.error("  Invalid sandbox name. Use lowercase letters, numbers, and hyphens.");
    process.exit(1);
  }

  const githubUser = nonInteractive ? (argGithubUser || "") : await askPrompt("  GitHub username (optional, press Enter to skip): ");
  const persistBase = `persist/users/${slackUserId}`;
  const credDir = `${persistBase}/credentials`;
  const workspaceDir = `${persistBase}/workspace`;
  let createdUser = false;
  let createdSandboxRegistryEntry = false;

  // Check if sandbox exists or needs to be created
  let sbExists = registry.getSandbox(sandboxName);
  const liveExists = pruneStaleSandboxEntry(sandboxName);
  sbExists = registry.getSandbox(sandboxName);
  if (!sbExists && liveExists) {
    registry.registerSandbox({
      name: sandboxName,
      model: "anthropic/claude-sonnet-4-6",
      provider: "openshell",
      gpuEnabled: false,
      policies: [],
    });
    createdSandboxRegistryEntry = true;
    sbExists = registry.getSandbox(sandboxName);
    console.log(`  Found existing live sandbox '${sandboxName}'. Adopting it into the local registry.`);
    await applyDefaultPolicies(sandboxName);
  }

  // Create per-user persist directories and registry entry before provisioning so
  // a slow or hanging sandbox create cannot leave an orphan sandbox with no user.
  fs.mkdirSync(path.join(ROOT, credDir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(ROOT, workspaceDir), { recursive: true });

  const defaultWorkspace = path.join(ROOT, "persist", "workspace");
  const userWorkspace = path.join(ROOT, workspaceDir);
  if (fs.existsSync(defaultWorkspace)) {
    copySharedWorkspaceFiles(ROOT, userWorkspace);
    console.log("  Default personality files copied to user workspace.");
  }

  userReg.registerUser({
    slackUserId,
    slackDisplayName,
    sandboxName,
    githubUser,
    personalityDir: workspaceDir,
    credentialsDir: credDir,
    enabled: true,
    roles: argAdmin ? ["user", "admin"] : ["user"],
  });
  createdUser = true;

  if (!sbExists) {
    const create = nonInteractive ? "y" : await askPrompt(`  Sandbox '${sandboxName}' not registered. Create it? [Y/n]: `);
    if (create.toLowerCase() !== "n") {
      console.log(`  Creating sandbox '${sandboxName}' (this may take a few minutes on first run)...`);

      try {
        createSandboxWithRecovery(sandboxName, { repoRoot: ROOT, stdio: "inherit" });
      } catch (err) {
        console.error(`  Failed to create sandbox: ${err.message}`);
        cleanupProvisioningArtifacts(slackUserId, sandboxName, persistBase, createdUser, createdSandboxRegistryEntry);
        process.exit(1);
      }

      registry.registerSandbox({
        name: sandboxName,
        model: "anthropic/claude-sonnet-4-6",
        provider: "openshell",
        gpuEnabled: false,
        policies: [],
      });
      createdSandboxRegistryEntry = true;
      console.log(`  Sandbox '${sandboxName}' created and registered.`);
      await applyDefaultPolicies(sandboxName);
    }
  }

  const roles = userReg.getUser(slackUserId)?.roles || ["user"];

  console.log("");
  console.log(`  User registered:`);
  console.log(`    Slack ID:    ${slackUserId}`);
  console.log(`    Name:        ${slackDisplayName}`);
  console.log(`    Sandbox:     ${sandboxName}`);
  console.log(`    GitHub:      ${githubUser || "(none)"}`);
  console.log(`    Roles:       ${roles.join(", ")}`);
  console.log(`    Credentials: ${credDir}`);
  console.log(`    Workspace:   ${workspaceDir}`);
  console.log("");
  console.log("  Next steps:");
  console.log(`    1. Place credentials in ${credDir}/`);
  console.log("       (claude-credentials.json, gh-hosts.yml, gogcli/)");
  console.log(`    2. Customize personality in ${workspaceDir}/`);
  console.log(`    3. Run: scripts/inject-user-credentials.sh ${sandboxName} ${credDir}` + (githubUser ? ` --github-user ${githubUser}` : ""));
  console.log("");
}

function userRemove(slackUserId) {
  if (!slackUserId) {
    console.error("  Usage: nemoclaw user-remove <slack-user-id>");
    process.exit(1);
  }

  const user = userReg.getUser(slackUserId);
  if (!user) {
    console.error(`  User ${slackUserId} not found in registry.`);
    process.exit(1);
  }

  console.log("");
  console.log(`  Removing user: ${user.slackDisplayName} (${slackUserId})`);
  console.log(`    Sandbox: ${user.sandboxName}`);

  userReg.removeUser(slackUserId);
  console.log(`  User removed from registry.`);
  console.log("");
  console.log("  Note: Sandbox and persist files were NOT deleted.");
  console.log(`  To also destroy the sandbox: nemoclaw ${user.sandboxName} destroy`);
  console.log(`  To delete user data: rm -rf persist/users/${slackUserId}`);
  console.log("");
}

function userPurge(args = []) {
  // Parse arguments: --sandbox <name> or --slack-id <id>
  let sandboxName, slackUserId;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--sandbox":  sandboxName = args[++i]; break;
      case "--slack-id": slackUserId = args[++i]; break;
    }
  }

  if (!sandboxName && !slackUserId) {
    console.error("  Usage: nemoclaw user-purge --sandbox <claw-name>");
    console.error("         nemoclaw user-purge --slack-id <slack-user-id>");
    process.exit(1);
  }

  // Resolve user from whichever identifier was given
  let user;
  if (slackUserId) {
    user = userReg.getUser(slackUserId);
  } else {
    user = userReg.getUserBySandbox(sandboxName);
  }

  if (!user) {
    // Even without a registry entry, allow purging by sandbox name
    if (sandboxName) {
      console.log("");
      console.log(`  No user found for sandbox '${sandboxName}'. Destroying sandbox only.`);
      const sb = registry.getSandbox(sandboxName);
      if (sb) {
        sandboxDestroy(sandboxName);
        console.log(`  Sandbox '${sandboxName}' destroyed.`);
      } else {
        // Try openshell directly in case it exists but isn't registered
        try {
          execFileSync("openshell", ["sandbox", "delete", sandboxName], { stdio: "inherit" });
          console.log(`  Sandbox '${sandboxName}' deleted via openshell.`);
        } catch {
          console.log(`  Sandbox '${sandboxName}' not found in openshell either.`);
        }
      }
      console.log("");
      return;
    }
    console.error(`  User ${slackUserId} not found in registry.`);
    process.exit(1);
  }

  slackUserId = user.slackUserId;
  sandboxName = user.sandboxName;

  console.log("");
  console.log(`  Purging user: ${user.slackDisplayName} (${slackUserId})`);
  console.log(`    Sandbox:   ${sandboxName}`);
  console.log("");

  // Step 1: Destroy sandbox (NIM + openshell + sandbox registry)
  const sb = registry.getSandbox(sandboxName);
  if (sb) {
    console.log("  [1/3] Destroying sandbox...");
    sandboxDestroy(sandboxName);
  } else {
    console.log("  [1/3] Sandbox not in registry, attempting openshell delete...");
    try {
      execFileSync("openshell", ["sandbox", "delete", sandboxName], { stdio: "inherit" });
    } catch {
      console.log(`         Sandbox '${sandboxName}' not found — skipping.`);
    }
  }

  // Step 2: Remove from user registry
  console.log("  [2/3] Removing from user registry...");
  userReg.removeUser(slackUserId);

  // Step 3: Delete persist data
  const persistDir = path.join(ROOT, "persist", "users", slackUserId);
  console.log("  [3/3] Deleting persist data...");
  if (fs.existsSync(persistDir)) {
    fs.rmSync(persistDir, { recursive: true, force: true });
    console.log(`         Removed ${persistDir}`);
  } else {
    console.log("         No persist directory found — skipping.");
  }

  console.log("");
  console.log(`  User '${user.slackDisplayName}' (${slackUserId}) fully purged.`);
  console.log("  Note: Restart the Slack bridge to stop routing messages for this user.");
  console.log("");
}

function userList() {
  const { users, defaultUser } = userReg.listUsers();
  if (users.length === 0) {
    console.log("");
    console.log("  No users registered. Run 'nemoclaw user-add' to get started.");
    console.log("");
    return;
  }

  console.log("");
  console.log("  Registered Users:");
  for (const u of users) {
    const def = u.slackUserId === defaultUser ? " *" : "";
    const status = u.enabled ? "enabled" : "disabled";
    console.log(`    ${u.slackDisplayName || u.slackUserId}${def}`);
    console.log(`      slack: ${u.slackUserId}  sandbox: ${u.sandboxName}  github: ${u.githubUser || "-"}  ${status}  roles: ${(u.roles || ["user"]).join(",")}`);
  }
  console.log("");
  console.log("  * = default user");
  console.log("");
}

function userStatus(slackUserId) {
  if (!slackUserId) {
    console.error("  Usage: nemoclaw user-status <slack-user-id>");
    process.exit(1);
  }

  const user = userReg.getUser(slackUserId);
  if (!user) {
    console.error(`  User ${slackUserId} not found in registry.`);
    process.exit(1);
  }

  console.log("");
  console.log(`  User: ${user.slackDisplayName} (${slackUserId})`);
  console.log(`    Sandbox:     ${user.sandboxName}`);
  console.log(`    GitHub:      ${user.githubUser || "-"}`);
  console.log(`    Enabled:     ${user.enabled}`);
  console.log(`    Roles:       ${(user.roles || ["user"]).join(", ")}`);
  console.log(`    Credentials: ${user.credentialsDir}`);
  console.log(`    Workspace:   ${user.personalityDir}`);
  console.log(`    Created:     ${user.createdAt}`);

  // Check sandbox health
  try {
    const out = execFileSync("openshell", ["sandbox", "list"], { encoding: "utf-8" });
    if (out.includes(user.sandboxName)) {
      const ready = out.includes(`${user.sandboxName}`) && out.includes("Ready");
      console.log(`    Sandbox:     ${ready ? "Ready" : "Not Ready"}`);
    } else {
      console.log("    Sandbox:     Not found (not created?)");
    }
  } catch {
    console.log("    Sandbox:     (cannot check — openshell not available)");
  }
  console.log("");
}

function userSetEnabled(slackUserId, enabled) {
  if (!slackUserId) {
    console.error(`  Usage: nemoclaw ${enabled ? "user-enable" : "user-disable"} <slack-user-id>`);
    process.exit(1);
  }

  const user = userReg.getUser(slackUserId);
  if (!user) {
    console.error(`  User ${slackUserId} not found in registry.`);
    process.exit(1);
  }

  if (!userReg.updateUser(slackUserId, { enabled })) {
    console.error(`  Failed to update ${slackUserId}.`);
    process.exit(1);
  }

  console.log("");
  console.log(`  User ${user.slackDisplayName || slackUserId} is now ${enabled ? "enabled" : "disabled"}.`);
  console.log("");
}

function userSetAdmin(slackUserId, grantAdmin) {
  if (!slackUserId) {
    console.error(`  Usage: nemoclaw ${grantAdmin ? "user-grant-admin" : "user-revoke-admin"} <slack-user-id>`);
    process.exit(1);
  }

  const user = userReg.getUser(slackUserId);
  if (!user) {
    console.error(`  User ${slackUserId} not found in registry.`);
    process.exit(1);
  }

  const roles = new Set(user.roles || ["user"]);
  roles.add("user");
  if (grantAdmin) roles.add("admin");
  else roles.delete("admin");

  if (!userReg.updateUser(slackUserId, { roles: [...roles] })) {
    console.error(`  Failed to update ${slackUserId}.`);
    process.exit(1);
  }

  console.log("");
  console.log(`  User ${user.slackDisplayName || slackUserId} roles: ${[...roles].join(", ")}`);
  console.log("");
}

function migrationExport(args = []) {
  let outputDir = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--output") outputDir = args[++i];
  }

  try {
    const result = exportMultiUserState({ outputDir });
    console.log("");
    console.log(`  Migration bundle exported: ${result.bundleRoot}`);
    console.log(`  Users captured: ${Object.keys(result.manifest.users || {}).length}`);
    console.log(`  Deleted users tracked: ${(result.manifest.registries.deletedUsers || []).length}`);
    console.log("");
  } catch (err) {
    console.error(`  Migration export failed: ${err.message}`);
    process.exit(1);
  }
}

function migrationImport(args = []) {
  let inputDir = null;
  let force = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--input") inputDir = args[++i];
    else if (args[i] === "--force") force = true;
  }

  if (!inputDir) {
    console.error("  Usage: nemoclaw migration-import --input <bundle-dir> [--force]");
    process.exit(1);
  }

  try {
    const result = importMultiUserState({ inputDir, force });
    console.log("");
    console.log(`  Migration bundle imported: ${result.bundleRoot}`);
    console.log(`  Users restored: ${Object.keys(result.manifest.users || {}).length}`);
    console.log(`  Paths restored: ${result.copied.length}`);
    console.log("");
  } catch (err) {
    console.error(`  Migration import failed: ${err.message}`);
    process.exit(1);
  }
}

function migrationInspect(args = []) {
  let inputDir = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--input") inputDir = args[++i];
  }

  if (!inputDir) {
    console.error("  Usage: nemoclaw migration-inspect --input <bundle-dir>");
    process.exit(1);
  }

  try {
    const result = inspectMultiUserState({ inputDir });
    console.log("");
    console.log(result.summary);
    console.log("");
  } catch (err) {
    console.error(`  Migration inspect failed: ${err.message}`);
    process.exit(1);
  }
}

function migrationRestoreUser(args = []) {
  let inputDir = null;
  let slackUserId = null;
  let force = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--input") inputDir = args[++i];
    else if (args[i] === "--slack-id") slackUserId = args[++i];
    else if (args[i] === "--force") force = true;
  }

  if (!inputDir || !slackUserId) {
    console.error("  Usage: nemoclaw migration-restore-user --input <bundle-dir> --slack-id <id> [--force]");
    process.exit(1);
  }

  try {
    const result = restoreUserFromBundle({ inputDir, slackUserId, force });
    console.log("");
    console.log(`  Restored user: ${result.user.slackDisplayName || slackUserId} (${slackUserId})`);
    console.log(`  Sandbox: ${result.user.sandboxName || "-"}`);
    console.log(`  Files restored: ${result.copied.length}`);
    console.log(`  Marker: ${path.join(ROOT, "persist", "migration", "restored-users", `${slackUserId}.json`)}`);
    console.log("");
  } catch (err) {
    console.error(`  User restore failed: ${err.message}`);
    process.exit(1);
  }
}

function migrationRestoreAll(args = []) {
  let inputDir = null;
  let force = false;
  let includeDisabled = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--input") inputDir = args[++i];
    else if (args[i] === "--force") force = true;
    else if (args[i] === "--include-disabled") includeDisabled = true;
  }

  if (!inputDir) {
    console.error("  Usage: nemoclaw migration-restore-all --input <bundle-dir> [--force] [--include-disabled]");
    process.exit(1);
  }

  try {
    const result = restoreAllUsersFromBundle({ inputDir, force, includeDisabled });
    console.log("");
    console.log(`  Restored users from bundle: ${result.bundleRoot}`);
    console.log(`  Users restored: ${result.restoredUsers.length}`);
    for (const restored of result.restoredUsers) {
      console.log(`    ${restored.user.slackDisplayName || restored.slackUserId} -> ${restored.user.sandboxName || "-"}`);
    }
    console.log("");
  } catch (err) {
    console.error(`  Bundle restore failed: ${err.message}`);
    process.exit(1);
  }
}

function bootstrapUserCommand(args = []) {
  const slackUserId = args.find((arg) => !arg.startsWith("-"));
  const dryRun = args.includes("--dry-run");
  if (!slackUserId) {
    console.error("  Usage: nemoclaw bootstrap-user <slack-user-id> [--dry-run]");
    process.exit(1);
  }
  try {
    const result = bootstrapUser(slackUserId, { dryRun });
    console.log("");
    console.log(formatBootstrapPlan(result.plan));
    if (dryRun) {
      console.log("\n  Dry run only. No sandbox changes were made.");
    } else {
      console.log(`\n  Workspace files seeded: ${result.copiedWorkspaceFiles.length}`);
      console.log(`  Policies applied: ${result.appliedPolicies.join(", ") || "-"}`);
      console.log("  Bootstrap complete.");
    }
    console.log("");
  } catch (err) {
    console.error(`  Bootstrap failed: ${err.message}`);
    process.exit(1);
  }
}

function bootstrapAllCommand(args = []) {
  const dryRun = args.includes("--dry-run");
  const includeDisabled = args.includes("--include-disabled");
  try {
    const results = bootstrapAll({ dryRun, includeDisabled });
    console.log("");
    if (results.length === 0) {
      console.log("  No users selected for bootstrap.\n");
      return;
    }
    for (const result of results) {
      console.log(formatBootstrapPlan(result.plan));
      console.log("");
    }
    if (dryRun) console.log("  Dry run only. No sandbox changes were made.\n");
    else console.log(`  Bootstrapped ${results.length} user(s).\n`);
  } catch (err) {
    console.error(`  Bootstrap failed: ${err.message}`);
    process.exit(1);
  }
}

function reconcileUserCommand(args = []) {
  const slackUserId = args.find((arg) => !arg.startsWith("-"));
  const dryRun = args.includes("--dry-run");
  if (!slackUserId) {
    console.error("  Usage: nemoclaw reconcile-user <slack-user-id> [--dry-run]");
    process.exit(1);
  }
  try {
    const result = reconcileUser(slackUserId, { dryRun });
    console.log("");
    console.log(formatReconcilePlan(result.plan));
    if (dryRun) console.log("\n  Dry run only. No sandbox changes were made.");
    else console.log("\n  Reconcile complete.");
    console.log("");
  } catch (err) {
    console.error(`  Reconcile failed: ${err.message}`);
    process.exit(1);
  }
}

function reconcileAllCommand(args = []) {
  const dryRun = args.includes("--dry-run");
  const includeDisabled = args.includes("--include-disabled");
  try {
    const results = reconcileAll({ dryRun, includeDisabled });
    console.log("");
    if (results.length === 0) {
      console.log("  No users selected for reconcile.");
      console.log("");
      return;
    }
    for (const result of results) {
      console.log(formatReconcilePlan(result.plan));
      console.log("");
    }
    if (dryRun) console.log("  Dry run only. No sandbox changes were made.\n");
    else console.log(`  Reconciled ${results.length} user(s).\n`);
  } catch (err) {
    console.error(`  Reconcile failed: ${err.message}`);
    process.exit(1);
  }
}

// ── Sandbox-scoped actions ───────────────────────────────────────

async function sandboxConnect(sandboxName) {
  await ensureLiveSandboxOrExit(sandboxName);
  const result = spawnSync(getOpenshellBinary(), ["sandbox", "connect", sandboxName], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });
  exitWithSpawnResult(result);
}

// eslint-disable-next-line complexity
async function sandboxStatus(sandboxName) {
  const sb = registry.getSandbox(sandboxName);
  const live = parseGatewayInference(
    captureOpenshell(["inference", "get"], { ignoreError: true }).output,
  );
  if (sb) {
    console.log("");
    console.log(`  Sandbox: ${sb.name}`);
    console.log(`    Model:    ${(live && live.model) || sb.model || "unknown"}`);
    console.log(`    Provider: ${(live && live.provider) || sb.provider || "unknown"}`);
    console.log(`    GPU:      ${sb.gpuEnabled ? "yes" : "no"}`);
    console.log(`    Policies: ${(sb.policies || []).join(", ") || "none"}`);
  }

  const lookup = await getReconciledSandboxGatewayState(sandboxName);
  if (lookup.state === "present") {
    console.log("");
    if (lookup.recoveredGateway) {
      console.log(
        `  Recovered NemoClaw gateway runtime via ${lookup.recoveryVia || "gateway reattach"}.`,
      );
      console.log("");
    }
    console.log(lookup.output);
  } else if (lookup.state === "missing") {
    registry.removeSandbox(sandboxName);
    console.log("");
    console.log(`  Sandbox '${sandboxName}' is not present in the live OpenShell gateway.`);
    console.log("  Removed stale local registry entry.");
  } else if (lookup.state === "identity_drift") {
    console.log("");
    console.log(
      `  Sandbox '${sandboxName}' is recorded locally, but the gateway trust material rotated after restart.`,
    );
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log(
      "  Existing sandbox connections cannot be reattached safely after this gateway identity change.",
    );
    console.log(
      "  Recreate this sandbox with `nemoclaw onboard` once the gateway runtime is stable.",
    );
  } else if (lookup.state === "gateway_unreachable_after_restart") {
    console.log("");
    console.log(
      `  Sandbox '${sandboxName}' may still exist, but the selected NemoClaw gateway is still refusing connections after restart.`,
    );
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log(
      "  Retry `openshell gateway start --name nemoclaw` and verify `openshell status` is healthy before reconnecting.",
    );
    console.log(
      "  If the gateway never becomes healthy, rebuild the gateway and then recreate the affected sandbox.",
    );
  } else if (lookup.state === "gateway_missing_after_restart") {
    console.log("");
    console.log(
      `  Sandbox '${sandboxName}' may still exist locally, but the NemoClaw gateway is no longer configured after restart/rebuild.`,
    );
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log(
      "  Start the gateway again with `openshell gateway start --name nemoclaw` before retrying.",
    );
    console.log(
      "  If the gateway had to be rebuilt from scratch, recreate the affected sandbox afterward.",
    );
  } else {
    console.log("");
    console.log(`  Could not verify sandbox '${sandboxName}' against the live OpenShell gateway.`);
    if (lookup.output) {
      console.log(lookup.output);
    }
    printGatewayLifecycleHint(lookup.output, sandboxName, console.log);
  }

  // NIM health
  const nimStat =
    sb && sb.nimContainer ? nim.nimStatusByName(sb.nimContainer) : nim.nimStatus(sandboxName);
  console.log(
    `    NIM:      ${nimStat.running ? `running (${nimStat.container})` : "not running"}`,
  );
  if (nimStat.running) {
    console.log(`    Healthy:  ${nimStat.healthy ? "yes" : "no"}`);
  }
  console.log("");
}

function sandboxLogs(sandboxName, follow) {
  const installedVersion = getInstalledOpenshellVersion();
  if (installedVersion && !versionGte(installedVersion, MIN_LOGS_OPENSHELL_VERSION)) {
    printOldLogsCompatibilityGuidance(installedVersion);
    process.exit(1);
  }

  const args = ["logs", sandboxName];
  if (follow) args.push("--tail");
  const result = spawnSync(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf-8",
    stdio: follow ? ["ignore", "inherit", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const combined = `${stdout}${stderr}`;
  if (!follow && stdout) {
    process.stdout.write(stdout);
  }
  if (result.status === 0) {
    return;
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
  if (
    /unrecognized subcommand 'logs'|unexpected argument '--tail'|unexpected argument '--follow'/i.test(
      combined,
    ) ||
    (installedVersion && !versionGte(installedVersion, MIN_LOGS_OPENSHELL_VERSION))
  ) {
    printOldLogsCompatibilityGuidance(installedVersion);
    process.exit(1);
  }
  if (result.status === null || result.signal) {
    exitWithSpawnResult(result);
  }
  console.error(`  Command failed (exit ${result.status}): openshell ${args.join(" ")}`);
  exitWithSpawnResult(result);
}

async function sandboxPolicyAdd(sandboxName) {
  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  const { prompt: askPrompt } = require("./lib/credentials");
  const answer = await policies.selectFromList(allPresets, { applied });
  if (!answer) return;

  const confirm = await askPrompt(`  Apply '${answer}' to sandbox '${sandboxName}'? [Y/n]: `);
  if (confirm.toLowerCase() === "n") return;

  policies.applyPreset(sandboxName, answer);
}

function sandboxPolicyList(sandboxName) {
  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  console.log("");
  console.log(`  Policy presets for sandbox '${sandboxName}':`);
  allPresets.forEach((p) => {
    const marker = applied.includes(p.name) ? "●" : "○";
    console.log(`    ${marker} ${p.name} — ${p.description}`);
  });
  console.log("");
}

async function sandboxDestroy(sandboxName, args = []) {
  const skipConfirm = args.includes("--yes") || args.includes("--force");
  if (!skipConfirm) {
    const { prompt: askPrompt } = require("./lib/credentials");
    const answer = await askPrompt(
      `  ${YW}Destroy sandbox '${sandboxName}'?${R} This cannot be undone. [y/N]: `,
    );
    if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
      console.log("  Cancelled.");
      return;
    }
  }

  console.log(`  Stopping NIM for '${sandboxName}'...`);
  const sb = registry.getSandbox(sandboxName);
  if (sb && sb.nimContainer) nim.stopNimContainerByName(sb.nimContainer);
  else nim.stopNimContainer(sandboxName);

  console.log(`  Deleting sandbox '${sandboxName}'...`);
  const deleteResult = runOpenshell(["sandbox", "delete", sandboxName], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { output: deleteOutput, alreadyGone } = getSandboxDeleteOutcome(deleteResult);

  if (deleteResult.status !== 0 && !alreadyGone) {
    if (deleteOutput) {
      console.error(`  ${deleteOutput}`);
    }
    console.error(`  Failed to destroy sandbox '${sandboxName}'.`);
    process.exit(deleteResult.status || 1);
  }

  const removed = registry.removeSandbox(sandboxName);
  if (
    (deleteResult.status === 0 || alreadyGone) &&
    removed &&
    registry.listSandboxes().sandboxes.length === 0 &&
    hasNoLiveSandboxes()
  ) {
    cleanupGatewayAfterLastSandbox();
  }
  if (alreadyGone) {
    console.log(`  Sandbox '${sandboxName}' was already absent from the live gateway.`);
  }
  console.log(`  ${G}✓${R} Sandbox '${sandboxName}' destroyed`);
}

// ── Help ─────────────────────────────────────────────────────────

function help() {
  console.log(`
  ${B}${G}NemoClaw${R}  ${D}v${getVersion()}${R}
  ${D}Deploy more secure, always-on AI assistants with a single command.${R}

  ${G}Getting Started:${R}
    ${B}nemoclaw onboard${R}                 Configure inference endpoint and credentials
                                    ${D}(non-interactive: ${NOTICE_ACCEPT_FLAG} or ${NOTICE_ACCEPT_ENV}=1)${R}
    nemoclaw setup-spark             Set up on DGX Spark ${D}(fixes cgroup v2 + Docker)${R}

  ${G}Sandbox Management:${R}
    ${B}nemoclaw list${R}                    List all sandboxes
    nemoclaw <name> connect          Shell into a running sandbox
    nemoclaw <name> status           Sandbox health + NIM status
    nemoclaw <name> logs ${D}[--follow]${R}  Stream sandbox logs
    nemoclaw <name> destroy          Stop NIM + delete sandbox ${D}(--yes to skip prompt)${R}

  ${G}Policy Presets:${R}
    nemoclaw <name> policy-add       Add a network or filesystem policy preset
    nemoclaw <name> policy-list      List presets ${D}(● = applied)${R}

  ${G}Multi-User:${R}
    nemoclaw user-add                Register a new user (interactive wizard)
    nemoclaw user-remove <slack-id>  Remove a user from registry (keeps sandbox/data)
    nemoclaw user-purge --sandbox <name>  Destroy sandbox + registry + persist data
    nemoclaw user-purge --slack-id <id>   Same, by Slack user ID
    nemoclaw user-list               List all registered users
    nemoclaw user-status <slack-id>  Show user details and sandbox health
    nemoclaw user-enable <slack-id>  Enable a registered user in the Slack bridge
    nemoclaw user-disable <slack-id> Disable a registered user in the Slack bridge
    nemoclaw user-grant-admin <id>   Grant admin role to a registered user
    nemoclaw user-revoke-admin <id>  Revoke admin role from a registered user
    nemoclaw migration-export [--output DIR]   Export local multi-user state bundle
    nemoclaw migration-import --input DIR [--force]  Restore a local multi-user state bundle
    nemoclaw migration-inspect --input DIR     Summarize a local multi-user state bundle
    nemoclaw migration-restore-user --input DIR --slack-id ID [--force]  Restore one user from a bundle
    nemoclaw migration-restore-all --input DIR [--force] [--include-disabled]  Restore all users from a bundle
    nemoclaw bootstrap-user <id> [--dry-run]   Create/adopt one user's sandbox and seed workspace defaults
    nemoclaw bootstrap-all [--dry-run] [--include-disabled]  Bootstrap sandboxes for all registered users
    nemoclaw reconcile-user <id> [--dry-run]   Reconcile one user's credentials into their sandbox
    nemoclaw reconcile-all [--dry-run] [--include-disabled]  Reconcile all registered users

  ${G}Deploy:${R}
    nemoclaw deploy <instance>       Deploy to a Brev VM and start services

  ${G}Services:${R}
    nemoclaw start                   Start auxiliary services ${D}(Telegram, tunnel)${R}
    nemoclaw stop                    Stop all services
    nemoclaw status                  Show sandbox list and service status

  Troubleshooting:
    nemoclaw debug [--quick]         Collect diagnostics for bug reports
    nemoclaw debug --output FILE     Save diagnostics tarball for GitHub issues

  Cleanup:
    nemoclaw uninstall [flags]       Run uninstall.sh (local first, curl fallback)

  ${G}Uninstall flags:${R}
    --yes                            Skip the confirmation prompt
    --keep-openshell                 Leave the openshell binary installed
    --delete-models                  Remove NemoClaw-pulled Ollama models

  ${D}Powered by NVIDIA OpenShell · Nemotron · Agent Toolkit
  Credentials saved in ~/.nemoclaw/credentials.json (mode 600)${R}
  ${D}https://www.nvidia.com/nemoclaw${R}
`);
}

// ── Dispatch ─────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

// eslint-disable-next-line complexity
(async () => {
  // No command → help
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    help();
    return;
  }

  // Global commands
  if (GLOBAL_COMMANDS.has(cmd)) {
    switch (cmd) {
      case "onboard":
        await onboard(args);
        break;
      case "setup":
        await setup(args);
        break;
      case "setup-spark":
        await setupSpark();
        break;
      case "deploy":
        await deploy(args[0]);
        break;
      case "start":
        await start();
        break;
      case "stop":
        stop();
        break;
      case "status":
        showStatus();
        break;
      case "debug":
        debug(args);
        break;
      case "uninstall":
        uninstall(args);
        break;
      case "list":
        await listSandboxes();
        break;
      case "user-add":
        await userAdd(args);
        break;
      case "user-remove":
        userRemove(args[0]);
        break;
      case "user-purge":
        userPurge(args);
        break;
      case "user-list":
        userList();
        break;
      case "user-status":
        userStatus(args[0]);
        break;
      case "user-enable":
        userSetEnabled(args[0], true);
        break;
      case "user-disable":
        userSetEnabled(args[0], false);
        break;
      case "user-grant-admin":
        userSetAdmin(args[0], true);
        break;
      case "user-revoke-admin":
        userSetAdmin(args[0], false);
        break;
      case "migration-export":
        migrationExport(args);
        break;
      case "migration-import":
        migrationImport(args);
        break;
      case "migration-inspect":
        migrationInspect(args);
        break;
      case "migration-restore-user":
        migrationRestoreUser(args);
        break;
      case "migration-restore-all":
        migrationRestoreAll(args);
        break;
      case "bootstrap-user":
        bootstrapUserCommand(args);
        break;
      case "bootstrap-all":
        bootstrapAllCommand(args);
        break;
      case "reconcile-user":
        reconcileUserCommand(args);
        break;
      case "reconcile-all":
        reconcileAllCommand(args);
        break;
      case "--version":
      case "-v": {
        console.log(`nemoclaw v${getVersion()}`);
        break;
      }
      default:
        help();
        break;
    }
    return;
  }

  // Sandbox-scoped commands: nemoclaw <name> <action>
  const sandbox = registry.getSandbox(cmd);
  if (sandbox) {
    validateName(cmd, "sandbox name");
    const action = args[0] || "connect";
    const actionArgs = args.slice(1);

    switch (action) {
      case "connect":
        await sandboxConnect(cmd);
        break;
      case "status":
        await sandboxStatus(cmd);
        break;
      case "logs":
        sandboxLogs(cmd, actionArgs.includes("--follow"));
        break;
      case "policy-add":
        await sandboxPolicyAdd(cmd);
        break;
      case "policy-list":
        sandboxPolicyList(cmd);
        break;
      case "destroy":
        await sandboxDestroy(cmd, actionArgs);
        break;
      default:
        console.error(`  Unknown action: ${action}`);
        console.error(`  Valid actions: connect, status, logs, policy-add, policy-list, destroy`);
        process.exit(1);
    }
    return;
  }

  if (args[0] === "connect") {
    validateName(cmd, "sandbox name");
    await recoverRegistryEntries({ requestedSandboxName: cmd });
    if (registry.getSandbox(cmd)) {
      await sandboxConnect(cmd);
      return;
    }
  }

  // Unknown command — suggest
  console.error(`  Unknown command: ${cmd}`);
  console.error("");

  // Check if it looks like a sandbox name with missing action
  const allNames = registry.listSandboxes().sandboxes.map((s) => s.name);
  if (allNames.length > 0) {
    console.error(`  Registered sandboxes: ${allNames.join(", ")}`);
    console.error(`  Try: nemoclaw <sandbox-name> connect`);
    console.error("");
  }

  console.error(`  Run 'nemoclaw help' for usage.`);
  process.exit(1);
})();
