// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Multi-user registry at ~/.nemoclaw/users.json

const fs = require("fs");
const path = require("path");

const REGISTRY_FILE = path.join(process.env.HOME || "/tmp", ".nemoclaw", "users.json");

function normalizeRoles(roles) {
  const raw = Array.isArray(roles)
    ? roles
    : typeof roles === "string" && roles.trim()
      ? roles.split(",")
      : [];
  const normalized = raw
    .map((role) => String(role).trim().toLowerCase())
    .filter(Boolean);
  if (!normalized.includes("user")) normalized.unshift("user");
  return [...new Set(normalized)];
}

function hydrateUser(slackUserId, entry = {}) {
  return {
    slackUserId: entry.slackUserId || slackUserId,
    slackDisplayName: entry.slackDisplayName || "",
    sandboxName: entry.sandboxName,
    githubUser: entry.githubUser || "",
    createdAt: entry.createdAt || new Date().toISOString(),
    personalityDir: entry.personalityDir || `persist/users/${slackUserId}/workspace`,
    credentialsDir: entry.credentialsDir || `persist/users/${slackUserId}/credentials`,
    enabled: entry.enabled !== undefined ? entry.enabled : true,
    timezone: entry.timezone || "UTC",
    roles: normalizeRoles(entry.roles),
  };
}

function load() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
      if (data && data.users && typeof data.users === "object") {
        for (const [slackUserId, entry] of Object.entries(data.users)) {
          data.users[slackUserId] = hydrateUser(slackUserId, entry);
        }
      }
      return data;
    }
  } catch {}
  return { users: {}, defaultUser: null, deletedUsers: [] };
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
  data.users[entry.slackUserId] = hydrateUser(entry.slackUserId, entry);
  if (!data.defaultUser) {
    data.defaultUser = entry.slackUserId;
  }
  save(data);
}

function updateUser(slackUserId, updates) {
  const data = load();
  if (!data.users[slackUserId]) return false;
  data.users[slackUserId] = hydrateUser(slackUserId, {
    ...data.users[slackUserId],
    ...updates,
  });
  save(data);
  return true;
}

function removeUser(slackUserId) {
  const data = load();
  if (!data.users[slackUserId]) return false;
  // Track deleted users so the bridge can silently ignore them
  if (!data.deletedUsers) data.deletedUsers = [];
  if (!data.deletedUsers.includes(slackUserId)) {
    data.deletedUsers.push(slackUserId);
  }
  delete data.users[slackUserId];
  if (data.defaultUser === slackUserId) {
    const remaining = Object.keys(data.users);
    data.defaultUser = remaining.length > 0 ? remaining[0] : null;
  }
  save(data);
  return true;
}

function isDeletedUser(slackUserId) {
  const data = load();
  return (data.deletedUsers || []).includes(slackUserId);
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
  isDeletedUser,
  listUsers,
  setDefault,
  normalizeRoles,
};
