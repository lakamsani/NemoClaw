#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { ROOT, SCRIPTS, run, runCapture, runInteractive } = require("./lib/runner");
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

// ── Global commands ──────────────────────────────────────────────

const GLOBAL_COMMANDS = new Set([
  "onboard", "list", "deploy", "setup", "setup-spark",
  "start", "stop", "status", "uninstall",
  "user-add", "user-remove", "user-list", "user-status",
  "help", "--help", "-h",
]);

const REMOTE_UNINSTALL_URL = "https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function resolveUninstallScript() {
  const candidates = [
    path.join(ROOT, "uninstall.sh"),
    path.join(__dirname, "..", "uninstall.sh"),
  ];

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
  const allowedArgs = new Set(["--non-interactive"]);
  const unknownArgs = args.filter((arg) => !allowedArgs.has(arg));
  if (unknownArgs.length > 0) {
    console.error(`  Unknown onboard option(s): ${unknownArgs.join(", ")}`);
    console.error("  Usage: nemoclaw onboard [--non-interactive]");
    process.exit(1);
  }
  const nonInteractive = args.includes("--non-interactive");
  await runOnboard({ nonInteractive });
}

async function setup() {
  console.log("");
  console.log("  ⚠  `nemoclaw setup` is deprecated. Use `nemoclaw onboard` instead.");
  console.log("     Running legacy setup.sh for backwards compatibility...");
  console.log("");
  await ensureApiKey();
  const { defaultSandbox } = registry.listSandboxes();
  const safeName = defaultSandbox && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(defaultSandbox) ? defaultSandbox : "";
  run(`bash "${SCRIPTS}/setup.sh" ${safeName}`);
}

async function setupSpark() {
  await ensureApiKey();
  run(`sudo -E NVIDIA_API_KEY="${process.env.NVIDIA_API_KEY}" bash "${SCRIPTS}/setup-spark.sh"`);
}

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
  const name = instanceName;
  const gpu = process.env.NEMOCLAW_GPU || "a2-highgpu-1g:nvidia-tesla-a100:1";

  console.log("");
  console.log(`  Deploying NemoClaw to Brev instance: ${name}`);
  console.log("");

  try {
    execSync("which brev", { stdio: "ignore" });
  } catch {
    console.error("brev CLI not found. Install: https://brev.nvidia.com");
    process.exit(1);
  }

  let exists = false;
  try {
    const out = execSync("brev ls 2>&1", { encoding: "utf-8" });
    exists = out.includes(name);
  } catch {}

  if (!exists) {
    console.log(`  Creating Brev instance '${name}' (${gpu})...`);
    run(`brev create ${name} --gpu "${gpu}"`);
  } else {
    console.log(`  Brev instance '${name}' already exists.`);
  }

  run(`brev refresh`, { ignoreError: true });

  console.log("  Waiting for SSH...");
  for (let i = 0; i < 60; i++) {
    try {
      execSync(`ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${name} 'echo ok' 2>/dev/null`, { encoding: "utf-8", stdio: "pipe" });
      break;
    } catch {
      if (i === 59) {
        console.error(`  Timed out waiting for SSH to ${name}`);
        process.exit(1);
      }
      spawnSync("sleep", ["3"]);
    }
  }

  console.log("  Syncing NemoClaw to VM...");
  run(`ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR ${name} 'mkdir -p /home/ubuntu/nemoclaw'`);
  run(`rsync -az --delete --exclude node_modules --exclude .git --exclude src -e "ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR" "${ROOT}/scripts" "${ROOT}/Dockerfile" "${ROOT}/nemoclaw" "${ROOT}/nemoclaw-blueprint" "${ROOT}/bin" "${ROOT}/package.json" ${name}:/home/ubuntu/nemoclaw/`);

  const envLines = [`NVIDIA_API_KEY=${process.env.NVIDIA_API_KEY}`];
  const ghToken = process.env.GITHUB_TOKEN;
  if (ghToken) envLines.push(`GITHUB_TOKEN=${ghToken}`);
  const tgToken = getCredential("TELEGRAM_BOT_TOKEN");
  if (tgToken) envLines.push(`TELEGRAM_BOT_TOKEN=${tgToken}`);
  const envTmp = path.join(os.tmpdir(), `nemoclaw-env-${Date.now()}`);
  fs.writeFileSync(envTmp, envLines.join("\n") + "\n", { mode: 0o600 });
  run(`scp -q -o StrictHostKeyChecking=no -o LogLevel=ERROR "${envTmp}" ${name}:/home/ubuntu/nemoclaw/.env`);
  fs.unlinkSync(envTmp);

  console.log("  Running setup...");
  runInteractive(`ssh -t -o StrictHostKeyChecking=no -o LogLevel=ERROR ${name} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && bash scripts/brev-setup.sh'`);

  if (tgToken) {
    console.log("  Starting services...");
    run(`ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR ${name} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && bash scripts/start-services.sh'`);
  }

  console.log("");
  console.log("  Connecting to sandbox...");
  console.log("");
  runInteractive(`ssh -t -o StrictHostKeyChecking=no -o LogLevel=ERROR ${name} 'cd /home/ubuntu/nemoclaw && set -a && . .env && set +a && openshell sandbox connect nemoclaw'`);
}

async function start() {
  await ensureApiKey();
  const { defaultSandbox } = registry.listSandboxes();
  const safeName = defaultSandbox && /^[a-zA-Z0-9._-]+$/.test(defaultSandbox) ? defaultSandbox : null;
  const sandboxEnv = safeName ? `SANDBOX_NAME="${safeName}"` : "";
  run(`${sandboxEnv} bash "${SCRIPTS}/start-services.sh"`);
}

function stop() {
  run(`bash "${SCRIPTS}/start-services.sh" --stop`);
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

  console.log(`  Local uninstall script not found; falling back to ${REMOTE_UNINSTALL_URL}`);
  const forwardedArgs = args.map(shellQuote).join(" ");
  const command = forwardedArgs.length > 0
    ? `curl -fsSL ${shellQuote(REMOTE_UNINSTALL_URL)} | bash -s -- ${forwardedArgs}`
    : `curl -fsSL ${shellQuote(REMOTE_UNINSTALL_URL)} | bash`;
  const result = spawnSync("bash", ["-c", command], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });
  exitWithSpawnResult(result);
}

function showStatus() {
  // Show sandbox registry
  const { sandboxes, defaultSandbox } = registry.listSandboxes();
  if (sandboxes.length > 0) {
    console.log("");
    console.log("  Sandboxes:");
    for (const sb of sandboxes) {
      const def = sb.name === defaultSandbox ? " *" : "";
      const model = sb.model ? ` (${sb.model})` : "";
      console.log(`    ${sb.name}${def}${model}`);
    }
    console.log("");
  }

  // Show service status
  run(`bash "${SCRIPTS}/start-services.sh" --status`);
}

function listSandboxes() {
  const { sandboxes, defaultSandbox } = registry.listSandboxes();
  if (sandboxes.length === 0) {
    console.log("");
    console.log("  No sandboxes registered. Run `nemoclaw onboard` to get started.");
    console.log("");
    return;
  }

  // Build user-to-sandbox lookup
  const { users } = userReg.listUsers();
  const sandboxUserMap = {};
  for (const u of users) {
    sandboxUserMap[u.sandboxName] = u.slackDisplayName || u.slackUserId;
  }

  console.log("");
  console.log("  Sandboxes:");
  for (const sb of sandboxes) {
    const def = sb.name === defaultSandbox ? " *" : "";
    const owner = sandboxUserMap[sb.name] || "-";
    const model = sb.model || "unknown";
    const provider = sb.provider || "unknown";
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

async function userAdd() {
  const { prompt: askPrompt } = require("./lib/credentials");

  console.log("");
  console.log("  NemoClaw — Register a new user");
  console.log("");

  const slackUserId = await askPrompt("  Slack user ID (e.g. U09R681EPQ9): ");
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

  const slackDisplayName = await askPrompt("  Slack display name: ");
  const sandboxName = await askPrompt("  Sandbox name (e.g. alice-claw): ");
  if (!sandboxName || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(sandboxName)) {
    console.error("  Invalid sandbox name. Use lowercase letters, numbers, and hyphens.");
    process.exit(1);
  }

  const githubUser = await askPrompt("  GitHub username (optional, press Enter to skip): ");

  // Check if sandbox exists or needs to be created
  const sbExists = registry.getSandbox(sandboxName);
  if (!sbExists) {
    const create = await askPrompt(`  Sandbox '${sandboxName}' not registered. Create it? [Y/n]: `);
    if (create.toLowerCase() !== "n") {
      console.log(`  Creating sandbox '${sandboxName}' (this may take a few minutes on first run)...`);

      // Stage build context (same as onboard flow)
      const { mkdtempSync } = require("fs");
      const buildCtx = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
      fs.copyFileSync(path.join(ROOT, "Dockerfile"), path.join(buildCtx, "Dockerfile"));
      execSync(`cp -r "${path.join(ROOT, "nemoclaw")}" "${buildCtx}/nemoclaw"`, { stdio: "inherit" });
      execSync(`cp -r "${path.join(ROOT, "nemoclaw-blueprint")}" "${buildCtx}/nemoclaw-blueprint"`, { stdio: "inherit" });
      execSync(`cp -r "${path.join(ROOT, "scripts")}" "${buildCtx}/scripts"`, { stdio: "inherit" });
      execSync(`rm -rf "${buildCtx}/nemoclaw/node_modules" "${buildCtx}/nemoclaw/src"`, { stdio: "ignore" });

      const basePolicyPath = path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
      const envArgs = [];
      if (process.env.NVIDIA_API_KEY) envArgs.push(`NVIDIA_API_KEY=${process.env.NVIDIA_API_KEY}`);

      try {
        execSync(
          `openshell sandbox create --from "${buildCtx}/Dockerfile" --name "${sandboxName}" --policy "${basePolicyPath}" -- env ${envArgs.join(" ")} nemoclaw-start 2>&1`,
          { stdio: "inherit", timeout: 300000 }
        );
      } catch (err) {
        console.error(`  Failed to create sandbox: ${err.message}`);
        execSync(`rm -rf "${buildCtx}"`, { stdio: "ignore" });
        process.exit(1);
      }
      execSync(`rm -rf "${buildCtx}"`, { stdio: "ignore" });

      registry.registerSandbox({
        name: sandboxName,
        model: "anthropic/claude-sonnet-4-6",
        provider: "openshell",
        gpuEnabled: false,
        policies: [],
      });
      console.log(`  Sandbox '${sandboxName}' created and registered.`);

      // Apply default policy presets (matching veyonce-claw: npm, pypi, slack)
      const policies = require("./lib/policies");
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

      const presetAnswer = await askPrompt(`  Apply default presets (${defaultPresets.join(", ")})? [Y/n/list]: `);

      let selectedPresets = defaultPresets;
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

      for (const preset of selectedPresets) {
        try {
          policies.applyPreset(sandboxName, preset);
        } catch (err) {
          console.error(`  Warning: failed to apply preset '${preset}': ${err.message}`);
        }
      }
      if (selectedPresets.length > 0) {
        console.log(`  Applied presets: ${selectedPresets.join(", ")}`);
      }
    }
  }

  // Create per-user persist directories
  const persistBase = `persist/users/${slackUserId}`;
  const credDir = `${persistBase}/credentials`;
  const workspaceDir = `${persistBase}/workspace`;
  fs.mkdirSync(path.join(ROOT, credDir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(ROOT, workspaceDir), { recursive: true });

  // Copy default personality files if workspace is empty
  const defaultWorkspace = path.join(ROOT, "persist", "workspace");
  const userWorkspace = path.join(ROOT, workspaceDir);
  if (fs.existsSync(defaultWorkspace)) {
    const files = ["SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "AGENTS.md", "BOOTSTRAP.md"];
    for (const f of files) {
      const src = path.join(defaultWorkspace, f);
      const dst = path.join(userWorkspace, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
      }
    }
    console.log("  Default personality files copied to user workspace.");
  }

  // Register user
  userReg.registerUser({
    slackUserId,
    slackDisplayName,
    sandboxName,
    githubUser,
    personalityDir: workspaceDir,
    credentialsDir: credDir,
    enabled: true,
  });

  console.log("");
  console.log(`  User registered:`);
  console.log(`    Slack ID:    ${slackUserId}`);
  console.log(`    Name:        ${slackDisplayName}`);
  console.log(`    Sandbox:     ${sandboxName}`);
  console.log(`    GitHub:      ${githubUser || "(none)"}`);
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
    console.log(`      slack: ${u.slackUserId}  sandbox: ${u.sandboxName}  github: ${u.githubUser || "-"}  ${status}`);
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
  console.log(`    Credentials: ${user.credentialsDir}`);
  console.log(`    Workspace:   ${user.personalityDir}`);
  console.log(`    Created:     ${user.createdAt}`);

  // Check sandbox health
  try {
    const out = execSync(`openshell sandbox list 2>&1`, { encoding: "utf-8" });
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

// ── Sandbox-scoped actions ───────────────────────────────────────

function sandboxConnect(sandboxName) {
  // Ensure port forward is alive before connecting
  run(`openshell forward start --background 18789 "${sandboxName}" 2>/dev/null || true`, { ignoreError: true });
  runInteractive(`openshell sandbox connect "${sandboxName}"`);
}

function sandboxStatus(sandboxName) {
  const sb = registry.getSandbox(sandboxName);
  if (sb) {
    console.log("");
    console.log(`  Sandbox: ${sb.name}`);
    console.log(`    Model:    ${sb.model || "unknown"}`);
    console.log(`    Provider: ${sb.provider || "unknown"}`);
    console.log(`    GPU:      ${sb.gpuEnabled ? "yes" : "no"}`);
    console.log(`    Policies: ${(sb.policies || []).join(", ") || "none"}`);
  }

  // openshell info
  run(`openshell sandbox get "${sandboxName}" 2>/dev/null || true`, { ignoreError: true });

  // NIM health
  const nimStat = nim.nimStatus(sandboxName);
  console.log(`    NIM:      ${nimStat.running ? `running (${nimStat.container})` : "not running"}`);
  if (nimStat.running) {
    console.log(`    Healthy:  ${nimStat.healthy ? "yes" : "no"}`);
  }
  console.log("");
}

function sandboxLogs(sandboxName, follow) {
  const followFlag = follow ? " --follow" : "";
  run(`openshell sandbox logs "${sandboxName}"${followFlag}`);
}

async function sandboxPolicyAdd(sandboxName) {
  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  console.log("");
  console.log("  Available presets:");
  allPresets.forEach((p) => {
    const marker = applied.includes(p.name) ? "●" : "○";
    console.log(`    ${marker} ${p.name} — ${p.description}`);
  });
  console.log("");

  const { prompt: askPrompt } = require("./lib/credentials");
  const answer = await askPrompt("  Preset to apply: ");
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

function sandboxDestroy(sandboxName) {
  console.log(`  Stopping NIM for '${sandboxName}'...`);
  nim.stopNimContainer(sandboxName);

  console.log(`  Deleting sandbox '${sandboxName}'...`);
  run(`openshell sandbox delete "${sandboxName}" 2>/dev/null || true`, { ignoreError: true });

  registry.removeSandbox(sandboxName);
  console.log(`  ✓ Sandbox '${sandboxName}' destroyed`);
}

// ── Help ─────────────────────────────────────────────────────────

function help() {
  console.log(`
  nemoclaw — NemoClaw CLI

  Getting Started:
    nemoclaw onboard                 Interactive setup wizard (recommended)
    nemoclaw setup                   Legacy setup (deprecated, use onboard)
    nemoclaw setup-spark             Set up on DGX Spark (fixes cgroup v2 + Docker)

  Sandbox Management:
    nemoclaw list                    List all sandboxes
    nemoclaw <name> connect          Connect to a sandbox
    nemoclaw <name> status           Show sandbox status and health
    nemoclaw <name> logs [--follow]  View sandbox logs
    nemoclaw <name> destroy          Stop NIM + delete sandbox

  Policy Presets:
    nemoclaw <name> policy-add       Add a policy preset to a sandbox
    nemoclaw <name> policy-list      List presets (● = applied)

  Multi-User:
    nemoclaw user-add                Register a new user (interactive wizard)
    nemoclaw user-remove <slack-id>  Remove a user from registry
    nemoclaw user-list               List all registered users
    nemoclaw user-status <slack-id>  Show user details and sandbox health

  Deploy:
    nemoclaw deploy <instance>       Deploy to a Brev VM and start services

  Services:
    nemoclaw start                   Start services (Telegram, tunnel)
    nemoclaw stop                    Stop all services
    nemoclaw status                  Show sandbox list and service status
    nemoclaw uninstall [flags]       Run uninstall.sh (local first, curl fallback)

  Uninstall flags:
    --yes                            Skip the confirmation prompt
    --keep-openshell                 Leave the openshell binary installed
    --delete-models                  Remove NemoClaw-pulled Ollama models

  Credentials are prompted on first use, then saved securely
  in ~/.nemoclaw/credentials.json (mode 600).
`);
}

// ── Dispatch ─────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

(async () => {
  // No command → help
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    help();
    return;
  }

  // Global commands
  if (GLOBAL_COMMANDS.has(cmd)) {
    switch (cmd) {
      case "onboard":     await onboard(args); break;
      case "setup":       await setup(); break;
      case "setup-spark": await setupSpark(); break;
      case "deploy":      await deploy(args[0]); break;
      case "start":       await start(); break;
      case "stop":        stop(); break;
      case "status":      showStatus(); break;
      case "uninstall":   uninstall(args); break;
      case "list":        listSandboxes(); break;
      case "user-add":    await userAdd(); break;
      case "user-remove": userRemove(args[0]); break;
      case "user-list":   userList(); break;
      case "user-status": userStatus(args[0]); break;
      default:            help(); break;
    }
    return;
  }

  // Sandbox-scoped commands: nemoclaw <name> <action>
  const sandbox = registry.getSandbox(cmd);
  if (sandbox) {
    const action = args[0] || "connect";
    const actionArgs = args.slice(1);

    switch (action) {
      case "connect":     sandboxConnect(cmd); break;
      case "status":      sandboxStatus(cmd); break;
      case "logs":        sandboxLogs(cmd, actionArgs.includes("--follow")); break;
      case "policy-add":  await sandboxPolicyAdd(cmd); break;
      case "policy-list": sandboxPolicyList(cmd); break;
      case "destroy":     sandboxDestroy(cmd); break;
      default:
        console.error(`  Unknown action: ${action}`);
        console.error(`  Valid actions: connect, status, logs, policy-add, policy-list, destroy`);
        process.exit(1);
    }
    return;
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
