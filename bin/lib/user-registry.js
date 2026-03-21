// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Multi-user registry at ~/.nemoclaw/users.json

const fs = require("fs");
const path = require("path");

const REGISTRY_FILE = path.join(process.env.HOME || "/tmp", ".nemoclaw", "users.json");

function load() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
    }
  } catch {}
  return { users: {}, defaultUser: null };
}

function save(data) {
  const dir = path.dirname(REGISTRY_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function getUser(slackUserId) {
  const data = load();
  return data.users[slackUserId] || null;
}

function getUserBySandbox(sandboxName) {
  const data = load();
  return Object.values(data.users).find((u) => u.sandboxName === sandboxName) || null;
}

function getDefault() {
  const data = load();
  if (data.defaultUser && data.users[data.defaultUser]) {
    return data.defaultUser;
  }
  const ids = Object.keys(data.users);
  return ids.length > 0 ? ids[0] : null;
}

function registerUser(entry) {
  const data = load();
  data.users[entry.slackUserId] = {
    slackUserId: entry.slackUserId,
    slackDisplayName: entry.slackDisplayName || "",
    sandboxName: entry.sandboxName,
    githubUser: entry.githubUser || "",
    createdAt: entry.createdAt || new Date().toISOString(),
    personalityDir: entry.personalityDir || `persist/users/${entry.slackUserId}/workspace`,
    credentialsDir: entry.credentialsDir || `persist/users/${entry.slackUserId}/credentials`,
    enabled: entry.enabled !== undefined ? entry.enabled : true,
  };
  if (!data.defaultUser) {
    data.defaultUser = entry.slackUserId;
  }
  save(data);
}

function updateUser(slackUserId, updates) {
  const data = load();
  if (!data.users[slackUserId]) return false;
  Object.assign(data.users[slackUserId], updates);
  save(data);
  return true;
}

function removeUser(slackUserId) {
  const data = load();
  if (!data.users[slackUserId]) return false;
  delete data.users[slackUserId];
  if (data.defaultUser === slackUserId) {
    const remaining = Object.keys(data.users);
    data.defaultUser = remaining.length > 0 ? remaining[0] : null;
  }
  save(data);
  return true;
}

function listUsers() {
  const data = load();
  return {
    users: Object.values(data.users),
    defaultUser: data.defaultUser,
  };
}

function setDefault(slackUserId) {
  const data = load();
  if (!data.users[slackUserId]) return false;
  data.defaultUser = slackUserId;
  save(data);
  return true;
}

module.exports = {
  load,
  save,
  getUser,
  getUserBySandbox,
  getDefault,
  registerUser,
  updateUser,
  removeUser,
  listUsers,
  setDefault,
};
