// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function makeBootstrapFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-repo-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-home-"));
  process.env.HOME = homeDir;

  const userId = "U0BOOTSTRAP1";
  writeJson(path.join(homeDir, ".nemoclaw", "users.json"), {
    users: {
      [userId]: {
        slackUserId: userId,
        slackDisplayName: "Bootstrap User",
        sandboxName: "bootstrap-claw",
        githubUser: "bootstrap-user",
        credentialsDir: `persist/users/${userId}/credentials`,
        personalityDir: `persist/users/${userId}/workspace`,
        enabled: true,
        roles: ["user"],
      },
      U0BOOTSTRAP2: {
        slackUserId: "U0BOOTSTRAP2",
        slackDisplayName: "Disabled Bootstrap",
        sandboxName: "bootstrap-disabled",
        credentialsDir: "persist/users/U0BOOTSTRAP2/credentials",
        personalityDir: "persist/users/U0BOOTSTRAP2/workspace",
        enabled: false,
        roles: ["user"],
      },
    },
    defaultUser: userId,
    deletedUsers: [],
  });
  writeText(path.join(repoRoot, "persist", "workspace", "SOUL.md"), "default soul");
  writeText(path.join(repoRoot, "persist", "workspace", "TOOLS.md"), "default tools");
  writeText(path.join(repoRoot, "persist", "users", userId, "credentials", ".gitkeep"), "");

  const bootstrap = require("../bin/lib/bootstrap.js");
  return { bootstrap, repoRoot, userId };
}

describe("bootstrap", () => {
  it("builds a dry-run plan for one user", () => {
    const { bootstrap, repoRoot, userId } = makeBootstrapFixture();
    const result = bootstrap.bootstrapUser(userId, { repoRoot, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.plan.sandboxName).toBe("bootstrap-claw");
    expect(result.plan.hasCredentialsDir).toBe(true);
    expect(result.plan.hasWorkspaceDir).toBe(false);
    expect(bootstrap.formatBootstrapPlan(result.plan)).toContain("Bootstrap User");
  });

  it("bootstrapAll skips disabled users by default", () => {
    const { bootstrap, repoRoot } = makeBootstrapFixture();
    const results = bootstrap.bootstrapAll({ repoRoot, dryRun: true });
    expect(results).toHaveLength(1);
    expect(results[0].plan.slackUserId).toBe("U0BOOTSTRAP1");
  });

  it("bootstrapAll can include disabled users", () => {
    const { bootstrap, repoRoot } = makeBootstrapFixture();
    const results = bootstrap.bootstrapAll({ repoRoot, dryRun: true, includeDisabled: true });
    expect(results).toHaveLength(2);
  });

  it("adds freshworks policy when Freshrelease credentials exist", () => {
    const { bootstrap, repoRoot, userId } = makeBootstrapFixture();
    writeText(path.join(repoRoot, "persist", "users", userId, "credentials", "freshrelease-api-key.txt"), "token");
    const result = bootstrap.bootstrapUser(userId, { repoRoot, dryRun: true });
    expect(result.plan.defaultPolicies).toContain("freshworks");
  });
});
