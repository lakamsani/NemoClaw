#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Slack -> NemoClaw bridge.
 *
 * Messages from Slack are forwarded to the OpenClaw agent running
 * inside the sandbox. When the agent needs external access, the
 * OpenShell TUI lights up for approval. Responses go back to Slack.
 *
 * Uses Socket Mode (no public URL required).
 *
 * Env:
 *   SLACK_BOT_TOKEN   — Bot User OAuth Token (xoxb-...)
 *   SLACK_APP_TOKEN   — App-Level Token with connections:write (xapp-...)
 *   NVIDIA_API_KEY    — for inference
 *   SANDBOX_NAME      — sandbox name (default: nemoclaw)
 *   ALLOWED_CHANNELS  — comma-separated Slack channel IDs to accept (optional, accepts all if unset)
 *   ALLOWED_USERS     — comma-separated Slack user IDs to accept (optional, accepts all if unset)
 */

const { execSync, spawn } = require("child_process");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const API_KEY = process.env.NVIDIA_API_KEY;
const SANDBOX = process.env.SANDBOX_NAME || "nemoclaw";
const ALLOWED_CHANNELS = process.env.ALLOWED_CHANNELS
  ? process.env.ALLOWED_CHANNELS.split(",").map((s) => s.trim())
  : null;
const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(",").map((s) => s.trim())
  : null;

if (!SLACK_BOT_TOKEN) { console.error("SLACK_BOT_TOKEN required"); process.exit(1); }
if (!SLACK_APP_TOKEN) { console.error("SLACK_APP_TOKEN required"); process.exit(1); }
if (!API_KEY) { console.error("NVIDIA_API_KEY required"); process.exit(1); }

// ── Run agent inside sandbox ──────────────────────────────────────

function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    const sshConfig = execSync(`"${OPENSHELL}" sandbox ssh-config "${SANDBOX}"`, { encoding: "utf-8" });

    const confPath = `/tmp/nemoclaw-slack-ssh-${sessionId}.conf`;
    require("fs").writeFileSync(confPath, sshConfig);

    const escaped = message.replace(/'/g, "'\\''");
    const cmd = `export NVIDIA_API_KEY='${API_KEY}' && export GOG_KEYRING_PASSWORD='${process.env.GOG_KEYRING_PASSWORD || "nemoclaw"}' && export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache && export OPENCLAW_NO_RESPAWN=1 && export ANTHROPIC_API_KEY='${process.env.ANTHROPIC_API_KEY || ""}' && source /sandbox/.bashrc 2>/dev/null; nemoclaw-start openclaw agent --agent main --local -m '${escaped}' --session-id 'slack-${sessionId}'`;

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
      timeout: 600000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      try { require("fs").unlinkSync(confPath); } catch {}

      // Extract the actual agent response — skip setup lines
      const lines = stdout.split("\n");
      const responseLines = lines.filter(
        (l) =>
          !l.startsWith("Setting up NemoClaw") &&
          !l.startsWith("[plugins]") &&
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
  // Lazy-require @slack/bolt so the error is clear if not installed
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
  });

  // Store bot user ID so we can strip self-mentions from messages
  let botUserId = null;
  try {
    const authResult = await app.client.auth.test({ token: SLACK_BOT_TOKEN });
    botUserId = authResult.user_id;
  } catch {}

  // Handle @mentions in channels
  app.event("app_mention", async ({ event, say }) => {
    await handleMessage(event, say);
  });

  // Handle direct messages
  app.event("message", async ({ event, say }) => {
    // Only handle DMs (im), skip channel messages (handled by app_mention)
    if (event.channel_type !== "im") return;
    // Skip bot messages and message edits
    if (event.subtype) return;
    await handleMessage(event, say);
  });

  async function handleMessage(event, say) {
    const channel = event.channel;
    const threadTs = event.thread_ts || event.ts;

    // Access control
    if (ALLOWED_CHANNELS && !ALLOWED_CHANNELS.includes(channel)) {
      console.log(`[ignored] channel ${channel} not in allowed list`);
      return;
    }
    if (ALLOWED_USERS && !ALLOWED_USERS.includes(event.user)) {
      console.log(`[ignored] user ${event.user} not in allowed list`);
      return;
    }

    // Strip bot mention from message text
    let text = event.text || "";
    if (botUserId) {
      text = text.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "").trim();
    }

    if (!text) return;

    const userName = event.user || "someone";
    console.log(`[${channel}] ${userName}: ${text}`);

    try {
      // Send a "thinking" message
      const thinkingMsg = await app.client.chat.postMessage({
        token: SLACK_BOT_TOKEN,
        channel,
        thread_ts: threadTs,
        text: "Working on it...",
      });

      const response = await runAgentInSandbox(text, `${channel}-${Date.now()}`);
      console.log(`[${channel}] agent: ${response.slice(0, 100)}...`);

      // Update the thinking message with the actual response
      await app.client.chat.update({
        token: SLACK_BOT_TOKEN,
        channel,
        ts: thinkingMsg.ts,
        text: response,
      });
    } catch (err) {
      console.error(`[${channel}] error:`, err.message);
      await say({ text: `Error: ${err.message}`, thread_ts: threadTs });
    }
  }

  await app.start();

  console.log("");
  console.log("  \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510");
  console.log("  \u2502  NemoClaw Slack Bridge                             \u2502");
  console.log("  \u2502                                                     \u2502");
  console.log("  \u2502  Sandbox:  " + (SANDBOX + "                              ").slice(0, 40) + "\u2502");
  console.log("  \u2502  Model:    anthropic/claude-sonnet-4-6             \u2502");
  console.log("  \u2502                                                     \u2502");
  console.log("  \u2502  Messages are forwarded to the OpenClaw agent      \u2502");
  console.log("  \u2502  inside the sandbox. Run 'openshell term' in       \u2502");
  console.log("  \u2502  another terminal to monitor + approve egress.     \u2502");
  console.log("  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518");
  console.log("");
}

main();
