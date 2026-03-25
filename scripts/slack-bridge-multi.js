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
 */

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const userRegistry = require("../bin/lib/user-registry");
const { isSetupCommand, handleSetup, setupHelp } = require("../bin/lib/credential-setup");

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const API_KEY = process.env.NVIDIA_API_KEY;
const ALLOWED_CHANNELS = process.env.ALLOWED_CHANNELS
  ? process.env.ALLOWED_CHANNELS.split(",").map((s) => s.trim())
  : null;

if (!SLACK_BOT_TOKEN) { console.error("SLACK_BOT_TOKEN required"); process.exit(1); }
if (!SLACK_APP_TOKEN) { console.error("SLACK_APP_TOKEN required"); process.exit(1); }
if (!API_KEY) { console.error("NVIDIA_API_KEY required"); process.exit(1); }

// ── Run agent inside sandbox ──────────────────────────────────────

function runAgentInSandbox(message, sessionId, sandboxName) {
  return new Promise((resolve) => {
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
    const cmd = `export NVIDIA_API_KEY='${API_KEY}' && export GOG_KEYRING_PASSWORD='${process.env.GOG_KEYRING_PASSWORD || "nemoclaw"}' && export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache && export OPENCLAW_NO_RESPAWN=1 && export ANTHROPIC_API_KEY='${process.env.ANTHROPIC_API_KEY || ""}' && source /sandbox/.bashrc 2>/dev/null; nemoclaw-start openclaw agent --agent main --local -m '${escaped}' --session-id 'slack-${sessionId}'`;

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
    if (u.enabled) {
      userMap[u.slackUserId] = u;
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
    async function reply(text) {
      await app.client.chat.postMessage({
        token: SLACK_BOT_TOKEN,
        channel,
        thread_ts: threadTs,
        text,
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
    const user = userMap[event.user];

    // ── !setup commands (self-service onboarding) ──────────────
    if (isSetupCommand(text)) {
      // !setup help is available to everyone
      if (text === "!setup help" || text === "!setup") {
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

      const setupText = text.slice("!setup ".length);
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
    if (!user) {
      if (isDM) {
        // User directly DMed the bot — tell them how to register
        console.log(`[unregistered] user ${event.user} DMed bot`);
        await reply("You're not registered with NemoClaw. Ask an admin to run: `nemoclaw user-add`\nYour Slack ID: `" + event.user + "`\n\nOnce registered, DM me `!setup help` to configure your credentials.");
      } else {
        // @mention in a channel — silently ignore, don't send unsolicited messages
        console.log(`[ignored] user ${event.user} not registered, mentioned bot in channel`);
      }
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

      const response = await runAgentInSandbox(text, `${event.user}-${channel}-${Date.now()}`, user.sandboxName);
      console.log(`[${channel}] ${user.sandboxName} → ${displayName}: ${response.slice(0, 100)}...`);

      await app.client.chat.update({
        token: SLACK_BOT_TOKEN,
        channel,
        ts: thinkingMsg.ts,
        text: response,
      });
    } catch (err) {
      console.error(`[${channel}] error for ${displayName}:`, err.message);
      await say({ text: `Error: ${err.message}`, thread_ts: threadTs });
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

main();
