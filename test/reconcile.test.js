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

function withTempModules() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reconcile-repo-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reconcile-home-"));
  process.env.HOME = homeDir;

  const userId = "U0RECONCILE1";
  writeJson(path.join(homeDir, ".nemoclaw", "users.json"), {
    users: {
      [userId]: {
        slackUserId: userId,
        slackDisplayName: "Recon User",
        sandboxName: "recon-claw",
        githubUser: "recon-user",
        credentialsDir: `persist/users/${userId}/credentials`,
        personalityDir: `persist/users/${userId}/workspace`,
        enabled: true,
        roles: ["user"],
      },
      U0RECONCILE2: {
        slackUserId: "U0RECONCILE2",
        slackDisplayName: "Disabled User",
        sandboxName: "disabled-claw",
        credentialsDir: "persist/users/U0RECONCILE2/credentials",
        personalityDir: "persist/users/U0RECONCILE2/workspace",
        enabled: false,
        roles: ["user"],
      },
    },
    defaultUser: userId,
    deletedUsers: [],
  });

  writeText(path.join(repoRoot, "persist", "users", userId, "credentials", "gh-hosts.yml"), "gh");
  writeText(path.join(repoRoot, "persist", "users", userId, "workspace", "SOUL.md"), "hi");
  writeText(
    path.join(repoRoot, "scripts", "inject-user-credentials.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
  );
  fs.chmodSync(path.join(repoRoot, "scripts", "inject-user-credentials.sh"), 0o755);

  const reconcile = require("../bin/lib/reconcile.js");
  return { reconcile, repoRoot, homeDir, userId };
}

describe("reconcile", () => {
  it("builds a dry-run plan for one user", () => {
    const { reconcile, repoRoot, userId } = withTempModules();
    const result = reconcile.reconcileUser(userId, { repoRoot, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.plan.sandboxName).toBe("recon-claw");
    expect(result.plan.credentialsDirExists).toBe(true);
    expect(result.plan.workspaceDirExists).toBe(true);
    expect(reconcile.formatReconcilePlan(result.plan)).toContain("Recon User");
  });

  it("reconcileAll skips disabled users by default", () => {
    const { reconcile, repoRoot } = withTempModules();
    const results = reconcile.reconcileAll({ repoRoot, dryRun: true });
    expect(results).toHaveLength(1);
    expect(results[0].plan.slackUserId).toBe("U0RECONCILE1");
  });

  it("reconcileAll can include disabled users", () => {
    const { reconcile, repoRoot } = withTempModules();
    const results = reconcile.reconcileAll({ repoRoot, dryRun: true, includeDisabled: true });
    expect(results).toHaveLength(2);
  });
});
