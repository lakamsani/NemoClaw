// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const migration = require("../bin/lib/migration.js");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function makeSourceTree() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-migration-repo-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-migration-home-"));
  const slackUserId = "U0TESTUSER1";
  writeJson(path.join(homeDir, ".nemoclaw", "users.json"), {
    users: {
      [slackUserId]: {
        slackUserId,
        slackDisplayName: "Test User",
        sandboxName: "test-claw",
        githubUser: "test-user",
        createdAt: "2026-04-05T00:00:00.000Z",
        personalityDir: `persist/users/${slackUserId}/workspace`,
        credentialsDir: `persist/users/${slackUserId}/credentials`,
        enabled: true,
        timezone: "America/Los_Angeles",
        roles: ["user", "admin"],
      },
    },
    defaultUser: slackUserId,
    deletedUsers: ["U0DELETED1"],
  });
  writeJson(path.join(homeDir, ".nemoclaw", "sandboxes.json"), {
    sandboxes: {
      "test-claw": {
        name: "test-claw",
        createdAt: "2026-04-05T00:00:00.000Z",
        model: "anthropic/claude-sonnet-4-6",
        provider: "anthropic",
        gpuEnabled: false,
        policies: ["github"],
      },
    },
    defaultSandbox: "test-claw",
  });

  const userRoot = path.join(repoRoot, "persist", "users", slackUserId);
  writeText(path.join(userRoot, "credentials", "gh-hosts.yml"), "github-token");
  writeText(path.join(userRoot, "credentials", "freshrelease-api-key.txt"), "freshrelease-key");
  writeText(path.join(userRoot, "credentials", "slack-webhook-url.txt"), "https://hooks.slack.com/services/test");
  writeText(path.join(userRoot, "credentials", "whatsapp-number.txt"), "+15551234567");
  writeText(path.join(userRoot, "credentials", "primary-model.txt"), "claude-sonnet");
  writeText(path.join(userRoot, "credentials", "yahoo-creds.env"), "YAHOO_APP_PASSWORD=test\n");
  writeText(path.join(userRoot, "credentials", "gogcli", "config.json"), '{"google":true}');
  writeText(path.join(userRoot, "workspace", "SOUL.md"), "You are helpful.");
  writeText(path.join(userRoot, "workspace", "MEMORY.md"), "Remember this.");
  writeText(path.join(userRoot, "workspace", "TOOLS.md"), "Use tools carefully.");

  writeText(path.join(repoRoot, "persist", "audit", "admin-actions.log"), '{"ok":true}\n');
  writeText(path.join(repoRoot, "persist", "pending-slack-runs.json"), '{"pending":[]}\n');
  writeText(path.join(repoRoot, "persist", "gateway", "paired.json"), '{"devices":[]}\n');

  return { repoRoot, homeDir, slackUserId };
}

describe("migration export/import", () => {
  it("exports a local multi-user bundle with registries, user state, and shared files", () => {
    const { repoRoot, homeDir, slackUserId } = makeSourceTree();
    const outputDir = path.join(repoRoot, "tmp-export");

    const { bundleRoot, manifest } = migration.exportMultiUserState({
      repoRoot,
      homeDir,
      outputDir,
    });

    expect(bundleRoot).toBe(outputDir);
    expect(manifest.version).toBe(1);
    expect(manifest.registries.defaultUser).toBe(slackUserId);
    expect(manifest.registries.deletedUsers).toEqual(["U0DELETED1"]);
    expect(manifest.users[slackUserId].credentialKinds).toEqual(
      expect.arrayContaining(["github", "freshrelease", "slack-webhook", "gogcli", "yahoo"]),
    );
    expect(manifest.users[slackUserId].workspaceFiles).toEqual(["MEMORY.md", "SOUL.md", "TOOLS.md"]);
    expect(manifest.users[slackUserId].notificationInventory).toEqual({
      slackWebhook: true,
      yahooSummary: true,
      whatsappForwarding: true,
      googleSummaries: true,
    });
    expect(manifest.users[slackUserId].serviceInventory.freshreleaseRest).toBe(true);
    expect(manifest.users[slackUserId].serviceInventory.memory).toBe(true);
    expect(manifest.users[slackUserId].metadata.whatsappNumber).toBe("+15551234567");
    expect(manifest.users[slackUserId].metadata.primaryModelPreference).toBe("claude-sonnet");
    expect(typeof manifest.ux.setupHelp).toBe("string");
    expect(typeof manifest.ux.adminHelp).toBe("string");
    expect(manifest.shared.notificationScripts.slackNotify).toBe(true);

    expect(fs.existsSync(path.join(bundleRoot, "registry", "users.json"))).toBe(true);
    expect(fs.existsSync(path.join(bundleRoot, "registry", "sandboxes.json"))).toBe(true);
    expect(fs.existsSync(path.join(bundleRoot, "users", slackUserId, "workspace", "SOUL.md"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(bundleRoot, "shared", "gateway", "paired.json"))).toBe(true);
  });

  it("imports a bundle into a clean repo/home", () => {
    const source = makeSourceTree();
    const bundleDir = path.join(source.repoRoot, "tmp-export");
    migration.exportMultiUserState({
      repoRoot: source.repoRoot,
      homeDir: source.homeDir,
      outputDir: bundleDir,
    });

    const destRepo = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-migration-dest-repo-"));
    const destHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-migration-dest-home-"));

    const { manifest, copied } = migration.importMultiUserState({
      repoRoot: destRepo,
      homeDir: destHome,
      inputDir: bundleDir,
    });

    expect(Object.keys(manifest.users)).toEqual([source.slackUserId]);
    expect(copied.length).toBeGreaterThan(0);
    expect(
      JSON.parse(fs.readFileSync(path.join(destHome, ".nemoclaw", "users.json"), "utf-8")).defaultUser,
    ).toBe(source.slackUserId);
    expect(
      fs.readFileSync(
        path.join(destRepo, "persist", "users", source.slackUserId, "credentials", "freshrelease-api-key.txt"),
        "utf-8",
      ),
    ).toBe("freshrelease-key");
    expect(
      fs.readFileSync(path.join(destRepo, "persist", "gateway", "paired.json"), "utf-8"),
    ).toContain('"devices"');
  });

  it("refuses to overwrite existing state without force", () => {
    const source = makeSourceTree();
    const bundleDir = path.join(source.repoRoot, "tmp-export");
    migration.exportMultiUserState({
      repoRoot: source.repoRoot,
      homeDir: source.homeDir,
      outputDir: bundleDir,
    });

    const destRepo = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-migration-force-repo-"));
    const destHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-migration-force-home-"));
    writeText(path.join(destHome, ".nemoclaw", "users.json"), "{}");

    expect(() =>
      migration.importMultiUserState({
        repoRoot: destRepo,
        homeDir: destHome,
        inputDir: bundleDir,
      }),
    ).toThrow(/--force/);
  });

  it("formats an inspect summary from a bundle", () => {
    const source = makeSourceTree();
    const bundleDir = path.join(source.repoRoot, "tmp-export");
    migration.exportMultiUserState({
      repoRoot: source.repoRoot,
      homeDir: source.homeDir,
      outputDir: bundleDir,
    });

    const { summary, manifest } = migration.inspectMultiUserState({
      repoRoot: source.repoRoot,
      inputDir: bundleDir,
    });

    expect(manifest.users[source.slackUserId].serviceInventory.freshreleaseRest).toBe(true);
    expect(summary).toContain("*Multi-User Migration Bundle*");
    expect(summary).toContain("Users: 1");
    expect(summary).toContain("Admins: 1");
    expect(summary).toContain("Test User");
    expect(summary).toContain("notifications=slackWebhook, yahooSummary, whatsappForwarding, googleSummaries");
    expect(summary).toContain("services=");
    expect(summary).toContain("freshreleaseRest");
  });

  it("restores a single user from a bundle into a clean target", () => {
    const source = makeSourceTree();
    const bundleDir = path.join(source.repoRoot, "tmp-export");
    migration.exportMultiUserState({
      repoRoot: source.repoRoot,
      homeDir: source.homeDir,
      outputDir: bundleDir,
    });

    const destRepo = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restore-user-repo-"));
    const destHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restore-user-home-"));
    const result = migration.restoreUserFromBundle({
      repoRoot: destRepo,
      homeDir: destHome,
      inputDir: bundleDir,
      slackUserId: source.slackUserId,
    });

    expect(result.user.sandboxName).toBe("test-claw");
    expect(
      fs.existsSync(path.join(destRepo, "persist", "users", source.slackUserId, "workspace", "SOUL.md")),
    ).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(destHome, ".nemoclaw", "users.json"), "utf-8")).users[source.slackUserId]
        .sandboxName,
    ).toBe("test-claw");
    expect(
      JSON.parse(fs.readFileSync(path.join(destHome, ".nemoclaw", "sandboxes.json"), "utf-8")).sandboxes["test-claw"]
        .provider,
    ).toBe("anthropic");
    expect(
      fs.existsSync(
        path.join(destRepo, "persist", "migration", "restored-users", `${source.slackUserId}.json`),
      ),
    ).toBe(true);
  });

  it("restores all users from a bundle and skips disabled users by default", () => {
    const source = makeSourceTree();
    const secondUserId = "U0TESTUSER2";
    writeJson(path.join(source.homeDir, ".nemoclaw", "users.json"), {
      users: {
        [source.slackUserId]: {
          slackUserId: source.slackUserId,
          slackDisplayName: "Test User",
          sandboxName: "test-claw",
          githubUser: "test-user",
          createdAt: "2026-04-05T00:00:00.000Z",
          personalityDir: `persist/users/${source.slackUserId}/workspace`,
          credentialsDir: `persist/users/${source.slackUserId}/credentials`,
          enabled: true,
          timezone: "America/Los_Angeles",
          roles: ["user", "admin"],
        },
        [secondUserId]: {
          slackUserId: secondUserId,
          slackDisplayName: "Disabled User",
          sandboxName: "disabled-claw",
          credentialsDir: `persist/users/${secondUserId}/credentials`,
          personalityDir: `persist/users/${secondUserId}/workspace`,
          enabled: false,
          roles: ["user"],
        },
      },
      defaultUser: source.slackUserId,
      deletedUsers: [],
    });
    writeJson(path.join(source.homeDir, ".nemoclaw", "sandboxes.json"), {
      sandboxes: {
        "test-claw": {
          name: "test-claw",
          provider: "anthropic",
        },
        "disabled-claw": {
          name: "disabled-claw",
          provider: "anthropic",
        },
      },
      defaultSandbox: "test-claw",
    });
    writeText(path.join(source.repoRoot, "persist", "users", secondUserId, "workspace", "SOUL.md"), "disabled");

    const bundleDir = path.join(source.repoRoot, "tmp-export-all");
    migration.exportMultiUserState({
      repoRoot: source.repoRoot,
      homeDir: source.homeDir,
      outputDir: bundleDir,
    });

    const destRepo = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restore-all-repo-"));
    const destHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restore-all-home-"));
    const result = migration.restoreAllUsersFromBundle({
      repoRoot: destRepo,
      homeDir: destHome,
      inputDir: bundleDir,
    });

    expect(result.restoredUsers).toHaveLength(1);
    expect(result.restoredUsers[0].slackUserId).toBe(source.slackUserId);
    expect(
      fs.existsSync(path.join(destRepo, "persist", "users", secondUserId)),
    ).toBe(false);
  });

  it("restoreAllUsersFromBundle can include disabled users", () => {
    const source = makeSourceTree();
    const secondUserId = "U0TESTUSER2";
    writeJson(path.join(source.homeDir, ".nemoclaw", "users.json"), {
      users: {
        [source.slackUserId]: {
          slackUserId: source.slackUserId,
          slackDisplayName: "Test User",
          sandboxName: "test-claw",
          credentialsDir: `persist/users/${source.slackUserId}/credentials`,
          personalityDir: `persist/users/${source.slackUserId}/workspace`,
          enabled: true,
          roles: ["user"],
        },
        [secondUserId]: {
          slackUserId: secondUserId,
          slackDisplayName: "Disabled User",
          sandboxName: "disabled-claw",
          credentialsDir: `persist/users/${secondUserId}/credentials`,
          personalityDir: `persist/users/${secondUserId}/workspace`,
          enabled: false,
          roles: ["user"],
        },
      },
      defaultUser: source.slackUserId,
      deletedUsers: [],
    });
    writeJson(path.join(source.homeDir, ".nemoclaw", "sandboxes.json"), {
      sandboxes: {
        "test-claw": { name: "test-claw", provider: "anthropic" },
        "disabled-claw": { name: "disabled-claw", provider: "anthropic" },
      },
      defaultSandbox: "test-claw",
    });
    writeText(path.join(source.repoRoot, "persist", "users", secondUserId, "workspace", "SOUL.md"), "disabled");

    const bundleDir = path.join(source.repoRoot, "tmp-export-all-2");
    migration.exportMultiUserState({
      repoRoot: source.repoRoot,
      homeDir: source.homeDir,
      outputDir: bundleDir,
    });

    const destRepo = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restore-all2-repo-"));
    const destHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restore-all2-home-"));
    const result = migration.restoreAllUsersFromBundle({
      repoRoot: destRepo,
      homeDir: destHome,
      inputDir: bundleDir,
      includeDisabled: true,
    });

    expect(result.restoredUsers).toHaveLength(2);
    expect(
      fs.existsSync(path.join(destRepo, "persist", "users", secondUserId, "workspace", "SOUL.md")),
    ).toBe(true);
  });

  it("force restore replaces stale existing user files", () => {
    const source = makeSourceTree();
    const bundleDir = path.join(source.repoRoot, "tmp-export-force");
    migration.exportMultiUserState({
      repoRoot: source.repoRoot,
      homeDir: source.homeDir,
      outputDir: bundleDir,
    });

    const destRepo = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restore-force-repo-"));
    const destHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restore-force-home-"));
    const staleUserDir = path.join(destRepo, "persist", "users", source.slackUserId);
    writeText(path.join(destHome, ".nemoclaw", "users.json"), "{}");
    writeText(path.join(staleUserDir, "workspace", "STALE.txt"), "stale");

    migration.restoreUserFromBundle({
      repoRoot: destRepo,
      homeDir: destHome,
      inputDir: bundleDir,
      slackUserId: source.slackUserId,
      force: true,
    });

    expect(fs.existsSync(path.join(staleUserDir, "workspace", "STALE.txt"))).toBe(false);
    expect(fs.existsSync(path.join(staleUserDir, "workspace", "SOUL.md"))).toBe(true);
  });
});
