#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// WhatsApp CLI — read and send messages via Baileys (runs on host, not sandbox).
//
// Usage:
//   whatsapp-bridge.js inbox [--count N]
//   whatsapp-bridge.js read <jid> [--count N]
//   whatsapp-bridge.js send <phone-or-jid> <message>
//   whatsapp-bridge.js contacts [--query <name>]
//
// Auth dir: /tmp/wa-login/auth (created by login.js)

const { makeWASocket, fetchLatestBaileysVersion, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason } = require("@whiskeysockets/baileys");
const pino = require("pino");
const path = require("path");

// Suppress Baileys session debug noise
const origWarn = console.warn;
const origLog = console.log;

const AUTH_DIR = path.join(__dirname, "..", "..", "persist", "users", process.env.SLACK_USER_ID || "default", "credentials", "whatsapp-auth");
const FALLBACK_AUTH_DIR = "/tmp/wa-login/auth";
const fs = require("fs");

function getAuthDir() {
  if (fs.existsSync(path.join(AUTH_DIR, "creds.json"))) return AUTH_DIR;
  if (fs.existsSync(path.join(FALLBACK_AUTH_DIR, "creds.json"))) return FALLBACK_AUTH_DIR;
  console.error("No WhatsApp auth found. Run: cd /tmp/wa-login && node login.js");
  process.exit(1);
}

function normalizeJid(input) {
  if (input.includes("@")) return input;
  // Strip +, spaces, dashes
  const num = input.replace(/[^0-9]/g, "");
  return `${num}@s.whatsapp.net`;
}

async function withSocket(fn) {
  const authDir = getAuthDir();
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
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  // Wait for connection
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Connection timeout (30s)")), 30000);
    sock.ev.on("connection.update", (update) => {
      if (update.connection === "open") { clearTimeout(timeout); resolve(); }
      if (update.connection === "close") {
        clearTimeout(timeout);
        const code = update.lastDisconnect?.error?.output?.statusCode;
        if (code === 515) {
          // Restart requested — resolve and let caller retry
          resolve();
        } else {
          reject(new Error(`Connection closed (code ${code})`));
        }
      }
    });
  });

  try {
    await fn(sock);
  } finally {
    // Suppress Baileys session closing noise
    console.log = () => {};
    console.warn = () => {};
    setTimeout(() => { try { sock.ws?.close(); } catch {} process.exit(0); }, 1000);
  }
}

async function cmdInbox(count) {
  await withSocket(async (sock) => {
    // Fetch recent chats
    const chats = await sock.groupFetchAllParticipating().catch(() => ({}));
    // Get recent messages from store (Baileys doesn't have a direct "inbox" — use chat list)
    const store = sock.store;

    // List recent contacts who messaged us
    console.log("Recent WhatsApp conversations (use 'read <jid>' to view messages):\n");
    console.log(`${"JID".padEnd(35)} Name`);
    console.log("-".repeat(70));

    // Get contacts
    const contacts = {};
    sock.ev.on("contacts.set", ({ contacts: c }) => {
      for (const contact of c) contacts[contact.id] = contact;
    });

    // Wait briefly for contacts to load
    await new Promise(r => setTimeout(r, 3000));

    // Use the contacts from creds
    const contactList = Object.entries(contacts).slice(0, count);
    if (contactList.length === 0) {
      console.log("(No cached contacts. Send/receive a message first to populate.)");
    }
    for (const [jid, contact] of contactList) {
      const name = contact.name || contact.notify || jid;
      console.log(`${jid.padEnd(35)} ${name}`);
    }
  });
}

async function cmdRead(jid, count) {
  const normalizedJid = normalizeJid(jid);
  await withSocket(async (sock) => {
    console.log(`Recent messages with ${normalizedJid}:\n`);
    // Baileys doesn't store history by default — fetch from WhatsApp
    const messages = await sock.fetchMessagesFromWA(normalizedJid, count).catch(() => null);
    if (!messages || messages.length === 0) {
      console.log("(No messages found or history not available.)");
      return;
    }
    for (const msg of messages) {
      const from = msg.key.fromMe ? "You" : (msg.pushName || normalizedJid);
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "(media/other)";
      const ts = new Date((msg.messageTimestamp || 0) * 1000).toLocaleString();
      console.log(`[${ts}] ${from}: ${text}`);
    }
  });
}

async function cmdSend(jid, message) {
  const normalizedJid = normalizeJid(jid);
  await withSocket(async (sock) => {
    await sock.sendMessage(normalizedJid, { text: message });
    console.log(`✅ Sent to ${normalizedJid}`);
  });
}

async function cmdContacts(query) {
  await withSocket(async (sock) => {
    const contacts = {};
    sock.ev.on("contacts.set", ({ contacts: c }) => {
      for (const contact of c) contacts[contact.id] = contact;
    });
    await new Promise(r => setTimeout(r, 3000));

    console.log(`${"JID".padEnd(35)} ${"Name".padEnd(25)} Phone`);
    console.log("-".repeat(80));

    for (const [jid, contact] of Object.entries(contacts)) {
      const name = contact.name || contact.notify || "";
      if (query && !name.toLowerCase().includes(query.toLowerCase()) && !jid.includes(query)) continue;
      const phone = jid.split("@")[0];
      console.log(`${jid.padEnd(35)} ${name.padEnd(25)} ${phone}`);
    }
  });
}

// Parse args
const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === "help") {
  console.log(`WhatsApp CLI (host-side bridge)

Commands:
  inbox [--count N]              List recent conversations
  read <phone-or-jid> [--count N] Read messages from a contact
  send <phone-or-jid> <message>  Send a message
  contacts [--query <name>]      List/search contacts

Examples:
  whatsapp-bridge.js send +15551234567 "Hello!"
  whatsapp-bridge.js contacts --query "Mom"
  whatsapp-bridge.js read 15551234567`);
  process.exit(0);
}

const countIdx = args.indexOf("--count");
const count = countIdx >= 0 ? parseInt(args[countIdx + 1]) || 20 : 20;
const queryIdx = args.indexOf("--query");
const query = queryIdx >= 0 ? args[queryIdx + 1] : null;

switch (cmd) {
  case "inbox":
    cmdInbox(count).catch(e => { console.error("Error:", e.message); process.exit(1); });
    break;
  case "read":
    cmdRead(args[1], count).catch(e => { console.error("Error:", e.message); process.exit(1); });
    break;
  case "send":
    if (!args[1] || !args[2]) { console.error("Usage: send <phone-or-jid> <message>"); process.exit(1); }
    cmdSend(args[1], args.slice(2).join(" ")).catch(e => { console.error("Error:", e.message); process.exit(1); });
    break;
  case "contacts":
    cmdContacts(query).catch(e => { console.error("Error:", e.message); process.exit(1); });
    break;
  default:
    console.error(`Unknown command: ${cmd}. Run with 'help' for usage.`);
    process.exit(1);
}
