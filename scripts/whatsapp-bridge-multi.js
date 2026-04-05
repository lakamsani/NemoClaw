#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Multi-user WhatsApp bridge — listens for incoming WhatsApp messages,
// routes them to the correct sandbox via the user registry, and sends
// responses back. Runs on the HOST (not sandbox) because WhatsApp Web
// requires a direct WebSocket that the sandbox proxy blocks.
//
// Setup:
//   1. Link WhatsApp: cd /tmp/wa-login && node login.js (scan QR)
//   2. Register users: add whatsapp-number.txt to persist/users/<id>/credentials/
//   3. Start: node scripts/whatsapp-bridge-multi.js
//
// Users register their WhatsApp via Slack: !setup whatsapp +1XXXXXXXXXX

"use strict";

const { makeWASocket, fetchLatestBaileysVersion, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason } = require("/tmp/wa-login/node_modules/@whiskeysockets/baileys");
const pino = require("/tmp/wa-login/node_modules/pino");
const path = require("path");
const fs = require("fs");
const { execSync, execFileSync, spawn } = require("child_process");

const REPO_DIR = path.resolve(__dirname, "..");
const AUTH_DIR = path.join(REPO_DIR, "persist", "gateway", "whatsapp-auth");
const FALLBACK_AUTH_DIR = "/tmp/wa-login/auth";

// Load .env
if (fs.existsSync(path.join(REPO_DIR, ".env"))) {
  for (const line of fs.readFileSync(path.join(REPO_DIR, ".env"), "utf-8").split("\n")) {
    const [k, ...v] = line.split("=");
    if (k && v.length && !k.startsWith("#")) process.env[k.trim()] = v.join("=").trim();
  }
}

// ── User registry ────────────────────────────────────────────────

const userRegistryPath = path.join(process.env.HOME || "/root", ".nemoclaw", "users.json");

function loadUserRegistry() {
  if (!fs.existsSync(userRegistryPath)) return {};
  const data = JSON.parse(fs.readFileSync(userRegistryPath, "utf-8"));
  return data.users || {};
}

// Map WhatsApp JID → user
// WhatsApp uses two JID formats:
//   - Standard: 15551234567@s.whatsapp.net
//   - Linked ID: 39239039361092@lid (newer linked device format)
// We store both the number-based JID and resolve LID→number at runtime.
function buildWhatsAppUserMap() {
  const users = loadUserRegistry();
  const waMap = {};
  const numberToUser = {};
  for (const [slackId, user] of Object.entries(users)) {
    if (!user.enabled) continue;
    const waFile = path.join(REPO_DIR, "persist", "users", slackId, "credentials", "whatsapp-number.txt");
    if (fs.existsSync(waFile)) {
      const number = fs.readFileSync(waFile, "utf-8").trim().replace(/[^0-9]/g, "");
      if (number) {
        const userData = { ...user, slackUserId: slackId, waNumber: number };
        waMap[`${number}@s.whatsapp.net`] = userData;
        numberToUser[number] = userData;
      }
    }
  }
  return { waMap, numberToUser };
}

// Cache LID → phone number mappings discovered at runtime
const lidToNumber = new Map();

let { waMap: waUserMap, numberToUser } = buildWhatsAppUserMap();

// Refresh user map periodically
setInterval(() => {
  const result = buildWhatsAppUserMap();
  waUserMap = result.waMap;
  numberToUser = result.numberToUser;
}, 60000);

// Resolve a JID to a registered user, handling both @s.whatsapp.net and @lid formats
function resolveUser(jid) {
  // Direct match (standard JID)
  if (waUserMap[jid]) return waUserMap[jid];

  // Check LID cache
  if (jid.endsWith("@lid")) {
    const cached = lidToNumber.get(jid);
    if (cached && waUserMap[`${cached}@s.whatsapp.net`]) {
      return waUserMap[`${cached}@s.whatsapp.net`];
    }
  }

  return null;
}

// ── OpenShell / sandbox helpers ──────────────────────────────────

function findOpenshell() {
  for (const p of ["/usr/local/bin/openshell", `${process.env.HOME}/.local/bin/openshell`]) {
    if (fs.existsSync(p)) return p;
  }
  try { return execSync("which openshell", { encoding: "utf-8" }).trim(); } catch {}
  return null;
}

const OPENSHELL = findOpenshell();

// ── Agent execution (fire-and-poll, same as Slack bridge) ────────

function sshExec(confPath, sandboxName, cmd, timeoutMs = 30000) {
  try {
    return execFileSync("ssh", ["-T", "-o", "ConnectTimeout=10", "-F", confPath, `openshell-${sandboxName}`, cmd], {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    if (err.stdout) return err.stdout.toString().trim();
    throw err;
  }
}

function filterAgentOutput(raw) {
  let cleaned = raw
    .replace(/\[agent\] run [^\n]+\n/g, "")
    .replace(/Failing gates:[\s\S]*?(?=\n[A-Z]|\n\n)/g, "")
    .replace(/Fix-it keys:[\s\S]*?(?=\n[A-Z]|\n\n)/g, "")
    .replace(/Context: session=[^\n]+\n/g, "")
    .replace(/^Command not found$/gm, "");

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
      !l.includes("Config integrity check failed") &&
      !l.includes("elevated is not available") &&
      !l.includes("getaddrinfo EAI_AGAIN") &&
      !l.includes("CAP_SETPCAP") &&
      !l.includes("\u250C\u2500") &&
      !l.includes("\u2502 ") &&
      !l.includes("\u2514\u2500") &&
      l.trim() !== "",
  ).join("\n").trim();
}

function sh(value) {
  return String(value).replace(/'/g, "'\\''");
}

// Per-user message queue (serialize per sandbox)
const userQueues = new Map();
function enqueueForUser(sandboxName, fn) {
  const prev = userQueues.get(sandboxName) || Promise.resolve();
  const next = prev.then(fn, fn);
  userQueues.set(sandboxName, next);
  return next;
}

async function runAgentInSandbox(message, sessionId, user) {
  const sandboxName = user.sandboxName;
  if (!OPENSHELL) return "Error: openshell not found.";

  let sshConfig;
  try {
    sshConfig = execSync(`"${OPENSHELL}" sandbox ssh-config "${sandboxName}"`, { encoding: "utf-8" });
  } catch {
    return `Error: Cannot reach sandbox '${sandboxName}'.`;
  }

  const confPath = `/tmp/nemoclaw-wa-ssh-${sessionId}.conf`;
  fs.writeFileSync(confPath, sshConfig);

  const escaped = message.replace(/'/g, "'\\''");
  const tag = `wa-${sessionId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const outFile = `/tmp/nemoclaw-agent-${tag}.out`;
  const rcFile = `/tmp/nemoclaw-agent-${tag}.rc`;

  const agentCmd = [
    `export NVIDIA_API_KEY='${sh(process.env.NVIDIA_API_KEY || "")}'`,
    `export HOME=/sandbox`,
    `find /sandbox/.openclaw/agents -name '*.lock' -mmin +2 -delete 2>/dev/null || true`,
    `nemoclaw-start openclaw agent --agent main --local -m '${escaped}' --session-id 'wa-${sessionId}'`,
  ].join("\n");

  const launchCmd = `( ${agentCmd} ) > ${outFile} 2>&1; echo $? > ${rcFile}`;

  try {
    sshExec(confPath, sandboxName, `nohup sh -c '${launchCmd.replace(/'/g, "'\\''")}' </dev/null >/dev/null 2>&1 &`, 15000);
  } catch {
    try { fs.unlinkSync(confPath); } catch {}
    return "Error launching agent.";
  }

  const maxWaitMs = 1800000; // 30 minutes
  const pollIntervalMs = 3000;
  const startTime = Date.now();
  let consecutiveFailures = 0;

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    try {
      const rc = sshExec(confPath, sandboxName, `cat ${rcFile} 2>/dev/null || echo __pending__`, 10000);
      consecutiveFailures = 0;
      if (rc === "__pending__") continue;

      const raw = sshExec(confPath, sandboxName, `cat ${outFile} 2>/dev/null`, 15000);
      sshExec(confPath, sandboxName, `rm -f ${outFile} ${rcFile} 2>/dev/null`, 5000);
      try { fs.unlinkSync(confPath); } catch {}

      const response = filterAgentOutput(raw);
      if (response) return response;
      if (rc !== "0") return `Agent error (code ${rc}).`;
      return "(no response)";
    } catch {
      consecutiveFailures++;
      if (consecutiveFailures >= 5) {
        try { fs.unlinkSync(confPath); } catch {}
        return "Error: sandbox unreachable.";
      }
    }
  }

  try {
    const raw = sshExec(confPath, sandboxName, `cat ${outFile} 2>/dev/null`, 10000);
    sshExec(confPath, sandboxName, `rm -f ${outFile} ${rcFile} 2>/dev/null`, 5000);
    try { fs.unlinkSync(confPath); } catch {}
    const partial = filterAgentOutput(raw);
    if (partial) return partial + "\n\n(timed out after 30 minutes)";
  } catch {}
  try { fs.unlinkSync(confPath); } catch {}
  return "Agent timed out.";
}

// ── Strip markdown for WhatsApp ──────────────────────────────────

function toWhatsAppText(text) {
  // Convert markdown bold **text** to WhatsApp bold *text*
  return text
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    // Convert markdown links [text](url) to text (url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    // Strip table pipes
    .replace(/^\|.*\|$/gm, (line) => {
      if (/^[\s|:-]+$/.test(line)) return "";
      return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim()).join("  ·  ");
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  // Find auth dir
  const authDir = fs.existsSync(path.join(AUTH_DIR, "creds.json")) ? AUTH_DIR :
    fs.existsSync(path.join(FALLBACK_AUTH_DIR, "creds.json")) ? FALLBACK_AUTH_DIR : null;

  if (!authDir) {
    console.error("No WhatsApp auth found. Run: cd /tmp/wa-login && node login.js");
    process.exit(1);
  }

  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const logger = pino({ level: "silent" });

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    logger,
    printQRInTerminal: false,
    browser: ["openclaw", "cli", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  sock.ev.on("creds.update", saveCreds);

  // Handle connection
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.error("QR code displayed — session not linked. Run login.js first.");
    }
    if (connection === "open") {
      console.log("[wa-bridge] WhatsApp Web connected.");
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error("[wa-bridge] Logged out. Re-run login.js to re-link.");
        process.exit(1);
      }
      if (code === 515) {
        console.log("[wa-bridge] Restart requested (515). Reconnecting in 3s...");
        setTimeout(() => main(), 3000);
        return;
      }
      console.error(`[wa-bridge] Connection closed (code ${code}). Reconnecting in 5s...`);
      setTimeout(() => main(), 5000);
    }
  });

  // Handle incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Skip own messages, status broadcasts, and non-text
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;

      const text = msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        null;

      if (!text) continue;

      const jid = msg.key.remoteJid;
      const pushName = msg.pushName || jid.split("@")[0];

      // Learn LID → number mapping from message participant info
      if (jid.endsWith("@lid") && msg.key.participant) {
        const participantNum = msg.key.participant.split("@")[0];
        if (/^\d+$/.test(participantNum)) {
          lidToNumber.set(jid, participantNum);
          console.log(`[wa-bridge] Learned LID mapping: ${jid} → ${participantNum}`);
        }
      }

      // Look up user (handles both @s.whatsapp.net and @lid)
      let user = resolveUser(jid);

      // For LID JIDs, also try to resolve via the sender's phone in pushName or participant
      if (!user && jid.endsWith("@lid")) {
        // Try all registered numbers against LID mapping files
        const lidNum = jid.split("@")[0];
        const lidMappingFiles = [
          `lid-mapping-${lidNum}.json`,
          `lid-mapping-${lidNum}_reverse.json`,
        ];
        // Check auth dir for LID mapping hints
        const authDir = fs.existsSync(path.join(AUTH_DIR, "creds.json")) ? AUTH_DIR : FALLBACK_AUTH_DIR;
        for (const [num, userData] of Object.entries(numberToUser)) {
          const mappingFile = path.join(authDir, `lid-mapping-${num}.json`);
          if (fs.existsSync(mappingFile)) {
            try {
              const mapping = JSON.parse(fs.readFileSync(mappingFile, "utf-8"));
              const lid = Object.keys(mapping)[0] || Object.values(mapping)[0];
              if (lid && jid.includes(lid.split("@")[0])) {
                lidToNumber.set(jid, num);
                user = userData;
                console.log(`[wa-bridge] Resolved LID via mapping file: ${jid} → ${num}`);
                break;
              }
            } catch {}
          }
          // Also check reverse mapping
          const revFile = path.join(authDir, `lid-mapping-${num}_reverse.json`);
          if (fs.existsSync(revFile)) {
            try {
              const mapping = JSON.parse(fs.readFileSync(revFile, "utf-8"));
              if (JSON.stringify(mapping).includes(jid.split("@")[0])) {
                lidToNumber.set(jid, num);
                user = userData;
                console.log(`[wa-bridge] Resolved LID via reverse mapping: ${jid} → ${num}`);
                break;
              }
            } catch {}
          }
        }
      }

      if (!user) {
        console.log(`[wa-bridge] Unknown sender: ${pushName} (${jid}) — ignoring`);
        await sock.sendMessage(jid, {
          text: "You're not registered with NemoClaw. Ask an admin to add your WhatsApp number, or use Slack: !setup whatsapp +<your-number>"
        }).catch(() => {});
        continue;
      }

      console.log(`[wa-bridge] ${pushName} → ${user.sandboxName}: ${text.slice(0, 80)}`);

      // Send typing indicator
      await sock.sendPresenceUpdate("composing", jid).catch(() => {});

      // ── Bridge commands (same as Slack bridge) ───────────
      const normalizedText = text.trim();
      let cmdResponse = null;

      // !setup commands
      if (/^!setup\b/i.test(normalizedText)) {
        try {
          const { handleSetup, setupHelp } = require("../bin/lib/credential-setup");
          const setupText = normalizedText.slice("!setup ".length).trim();
          if (!setupText || setupText === "help") {
            cmdResponse = setupHelp();
          } else {
            const { response: r } = handleSetup(user, setupText);
            cmdResponse = r;
          }
        } catch (err) {
          cmdResponse = `Setup error: ${err.message}`;
        }
      }

      // !yahoo commands
      if (!cmdResponse && /^!yahoo\b/i.test(normalizedText)) {
        const yahooCredsPath = `${REPO_DIR}/persist/users/${user.slackUserId}/credentials/yahoo-creds.env`;
        if (!fs.existsSync(yahooCredsPath)) {
          cmdResponse = "No Yahoo credentials configured. Use: !setup help";
        } else {
          const yahooCreds = {};
          fs.readFileSync(yahooCredsPath, "utf-8").split("\n").forEach((line) => {
            const [k, ...v] = line.split("=");
            if (k && v.length) yahooCreds[k.trim()] = v.join("=").trim();
          });
          const yahooCmd = normalizedText.slice("!yahoo ".length).trim();
          if (!yahooCmd || yahooCmd === "help") {
            cmdResponse = "Yahoo commands:\n!yahoo inbox [--count N] [--unread]\n!yahoo read <id>\n!yahoo send --to <addr> --subject \"...\" --body \"...\"\n!yahoo search <query>";
          } else {
            try {
              cmdResponse = execFileSync("python3", [`${REPO_DIR}/scripts/yahoo-mail.py`, ...yahooCmd.split(/\s+/)], {
                encoding: "utf-8",
                timeout: 30000,
                env: { ...process.env, ...yahooCreds },
              }).trim();
            } catch (err) {
              cmdResponse = `Yahoo error: ${(err.stderr || err.message || "").slice(0, 300)}`;
            }
          }
        }
      }

      // !wa / !whatsapp commands (from WhatsApp itself)
      if (!cmdResponse && /^!(wa|whatsapp)\b/i.test(normalizedText)) {
        const waCmd = normalizedText.replace(/^!(whatsapp|wa)\s*/i, "").trim();
        if (!waCmd || waCmd === "help") {
          cmdResponse = "WhatsApp commands:\n!wa send <phone> <message>\n!wa contacts [--query <name>]\n!wa inbox\n!wa read <phone>";
        } else if (/^send\b/i.test(waCmd)) {
          const parts = waCmd.replace(/^send\s+/i, "").match(/^(\+?\d+)\s+(.+)$/s);
          if (parts) {
            try {
              const targetJid = parts[1].replace(/[^0-9]/g, "") + "@s.whatsapp.net";
              await sock.sendMessage(targetJid, { text: parts[2] });
              cmdResponse = `Sent to ${parts[1]}`;
            } catch (err) {
              cmdResponse = `Send failed: ${err.message}`;
            }
          } else {
            cmdResponse = "Usage: !wa send <phone> <message>";
          }
        } else {
          try {
            cmdResponse = execFileSync("node", [`${REPO_DIR}/scripts/whatsapp-bridge.js`, ...waCmd.split(/\s+/)], {
              encoding: "utf-8",
              timeout: 45000,
              env: { ...process.env, SLACK_USER_ID: user.slackUserId },
            }).trim();
          } catch (err) {
            cmdResponse = `WhatsApp error: ${(err.stderr || err.stdout || err.message || "").slice(0, 300)}`;
          }
        }
      }

      // !admin commands (admins only)
      if (!cmdResponse && /^!(admin|show-claws|show-user|admins)\b/i.test(normalizedText)) {
        const roles = user.roles || ["user"];
        if (roles.includes("admin")) {
          if (/^!admins$/i.test(normalizedText)) {
            const users = loadUserRegistry();
            const admins = Object.values(users).filter(u => (u.roles || []).includes("admin"));
            cmdResponse = "Admins:\n" + admins.map(a => `• ${a.slackDisplayName} (${a.sandboxName})`).join("\n");
          } else if (/^!show-claws$/i.test(normalizedText)) {
            cmdResponse = "Use Slack for !show-claws (table formatting required).";
          } else {
            cmdResponse = "Admin commands with table output are best used via Slack.";
          }
        } else {
          cmdResponse = "Admin commands require admin role.";
        }
      }

      // !help
      if (!cmdResponse && /^!help$/i.test(normalizedText)) {
        cmdResponse = "Available commands:\n\n" +
          "!setup help — Configure credentials\n" +
          "!yahoo help — Yahoo mail commands\n" +
          "!wa help — WhatsApp commands\n" +
          "!admins — List admins\n" +
          "!help — This message\n\n" +
          "Or just type anything to chat with your claw.";
      }

      // If a command was handled, send response and skip agent
      if (cmdResponse) {
        const waResponse = toWhatsAppText(cmdResponse);
        await sock.sendMessage(jid, { text: waResponse }).catch((err) => {
          console.error(`[wa-bridge] Send failed: ${err.message}`);
        });
        await sock.sendPresenceUpdate("paused", jid).catch(() => {});
        console.log(`[wa-bridge] cmd response → ${pushName}: ${waResponse.slice(0, 80)}...`);
        continue;
      }

      // ── Route to sandbox agent ─────────────────────────
      const sessionId = `${jid.split("@")[0]}-${Date.now()}`;
      const response = await enqueueForUser(user.sandboxName, () =>
        runAgentInSandbox(text, sessionId, user)
      );

      // Send response back via WhatsApp
      const waResponse = toWhatsAppText(response);

      // WhatsApp has a ~65K char limit but split at 4000 for readability
      const chunks = [];
      let remaining = waResponse;
      while (remaining.length > 0) {
        if (remaining.length <= 4000) {
          chunks.push(remaining);
          break;
        }
        // Split at last newline before 4000
        const splitAt = remaining.lastIndexOf("\n", 4000);
        const idx = splitAt > 2000 ? splitAt : 4000;
        chunks.push(remaining.slice(0, idx));
        remaining = remaining.slice(idx).trim();
      }

      for (const chunk of chunks) {
        await sock.sendMessage(jid, { text: chunk }).catch((err) => {
          console.error(`[wa-bridge] Send failed to ${jid}: ${err.message}`);
        });
      }

      await sock.sendPresenceUpdate("paused", jid).catch(() => {});
      console.log(`[wa-bridge] ${user.sandboxName} → ${pushName}: ${response.slice(0, 80)}...`);
    }
  });

  // Print banner
  const userCount = Object.keys(waUserMap).length;
  const userList = Object.entries(waUserMap).map(([jid, u]) => `${u.slackDisplayName || u.slackUserId} → ${u.sandboxName} (${u.waNumber || jid.split("@")[0]})`);

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Multi-User WhatsApp Bridge                │");
  console.log("  │                                                     │");
  console.log("  │  Users: " + (String(userCount) + " registered                            ").slice(0, 43) + "│");
  for (const line of userList) {
    console.log("  │    " + (line + "                                               ").slice(0, 47) + "│");
  }
  console.log("  │                                                     │");
  console.log("  │  Messages are routed by WhatsApp number to the      │");
  console.log("  │  correct sandbox. DM the bot to chat with your claw.│");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");
}

main().catch((err) => {
  console.error("[wa-bridge] Fatal:", err.message);
  process.exit(1);
});
