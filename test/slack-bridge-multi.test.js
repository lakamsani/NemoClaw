// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const bridge = await import("../scripts/slack-bridge-multi.js");

describe("slack-bridge-multi helpers", () => {
  it("parses quoted command arguments", () => {
    expect(bridge.parseCommandArgs('!add-claw U123ABC "Jane Doe" jane-claw janedoe')).toEqual([
      "!add-claw",
      "U123ABC",
      "Jane Doe",
      "jane-claw",
      "janedoe",
    ]);
  });

  it("recognizes admin commands", () => {
    expect(bridge.isListAdminsCommand("!admins")).toBe(true);
    expect(bridge.isAdminAuditCommand("!admin-audit")).toBe(true);
    expect(bridge.isAdminHelpCommand("!admin-help")).toBe(true);
    expect(bridge.isShowClawsCommand("!show-claws")).toBe(true);
    expect(bridge.isShowUserCommand("!show-user U123ABC")).toBe(true);
    expect(bridge.isAddClawCommand("!add-claw U123ABC Jane jane-claw janedoe")).toBe(true);
    expect(bridge.isDeleteClawCommand("!delete-claw jane-claw")).toBe(true);
    expect(bridge.isConfirmDeleteClawCommand("!confirm-delete-claw jane-claw")).toBe(true);
  });

  it("builds admin users from roles and allowlist-only entries", () => {
    const admins = bridge.buildAdminUserList(
      [
        { slackUserId: "U1", slackDisplayName: "Alice", sandboxName: "alice-claw", roles: ["user", "admin"], enabled: true },
        { slackUserId: "U2", slackDisplayName: "Bob", sandboxName: "bob-claw", roles: ["user"], enabled: true },
      ],
      new Set(["U3"])
    );

    expect(admins.map((entry) => entry.slackUserId)).toEqual(["U1", "U3"]);
    expect(admins[1].enabled).toBe(false);
  });

  it("formats admin user lists", () => {
    const text = bridge.formatAdminUsersFromList([
      { slackUserId: "U1", slackDisplayName: "Alice", sandboxName: "alice-claw", enabled: true },
      { slackUserId: "U3", slackDisplayName: "U3", sandboxName: "", enabled: false },
    ]);

    expect(text).toContain("*Admin Users*");
    expect(text).toContain("Alice (`U1`) — sandbox: `alice-claw`");
    expect(text).toContain("U3 (`U3`)");
  });

  it("detects admin role membership", () => {
    expect(bridge.isAdminUser({ roles: ["user", "admin"] })).toBe(true);
    expect(bridge.isAdminUser({ roles: ["user"] })).toBe(false);
  });

  it("parses live sandbox list output", () => {
    const sandboxes = bridge.parseSandboxList(`
NAME          NAMESPACE  CREATED              PHASE
alice-claw    openshell  2026-03-28 10:00:00  Ready
bob-claw      openshell  2026-03-28 10:05:00  Pending
`);

    expect([...sandboxes.keys()]).toEqual(["alice-claw", "bob-claw"]);
    expect(sandboxes.get("alice-claw")).toEqual({
      name: "alice-claw",
      namespace: "openshell",
      createdAt: "2026-03-28 10:00:00",
      phase: "Ready",
    });
  });

  it("formats uptime durations", () => {
    expect(bridge.formatDurationFrom("2999-01-01 00:00:00")).toBe("0m");
    expect(bridge.formatDurationFrom("invalid")).toBe("unknown");
  });

  it("detects configured per-user credentials", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-creds-"));
    const credentialsDir = path.join(tempRoot, "credentials");
    fs.mkdirSync(path.join(credentialsDir, "gogcli"), { recursive: true });
    fs.writeFileSync(path.join(credentialsDir, "gh-hosts.yml"), "github.com:\n");
    fs.writeFileSync(path.join(credentialsDir, "freshrelease-api-key.txt"), "x");
    fs.writeFileSync(path.join(credentialsDir, "gogcli", "config.json"), "{}");

    const configured = bridge.listConfiguredCredentials({ credentialsDir });

    expect(configured).toEqual(["GitHub", "Google (gogcli)", "Freshrelease"]);
  });

  it("formats claw inventory details", () => {
    const text = bridge.formatClawInventory([
      {
        name: "alice-claw",
        user: {
          slackUserId: "U1",
          slackDisplayName: "Alice",
          githubUser: "alicehub",
        },
        registrySandbox: {
          provider: "openshell",
          gpuEnabled: true,
        },
        liveSandbox: {
          phase: "Ready",
          createdAt: "2999-01-01 00:00:00",
        },
        policies: ["npm", "pypi"],
        credentials: ["GitHub", "Google (gogcli)"],
      },
    ]);

    expect(text).toContain("*Claw Inventory*");
    expect(text).toContain("`alice-claw`");
    expect(text).toContain("Alice (`U1`)");
    expect(text).toContain("github: `alicehub`");
    expect(text).toContain("credentials: GitHub, Google (gogcli)");
    expect(text).toContain("policies: npm, pypi, provider=openshell, gpu=true");
  });

  it("parses show-claws filter options", () => {
    expect(bridge.parseShowClawsOptions('!show-claws ready admins sort=user policy=slack cred=github match=alice')).toEqual({
      filters: ["ready", "admins"],
      sort: "user",
      match: "alice",
      policy: "slack",
      credential: "github",
    });
  });

  it("filters and sorts claw inventory", () => {
    const filtered = bridge.filterAndSortClawInventory([
      {
        name: "zeta-claw",
        user: { slackUserId: "U2", slackDisplayName: "Zeta", roles: ["user"] },
        liveSandbox: { phase: "Ready", createdAt: "2026-03-28 10:00:00" },
        registrySandbox: { gpuEnabled: false },
        policies: ["slack"],
        credentials: ["GitHub"],
      },
      {
        name: "alpha-claw",
        user: { slackUserId: "U1", slackDisplayName: "Alpha", roles: ["user", "admin"] },
        liveSandbox: { phase: "Ready", createdAt: "2026-03-28 09:00:00" },
        registrySandbox: { gpuEnabled: true },
        policies: ["slack", "npm"],
        credentials: ["GitHub", "Google (gogcli)"],
      },
    ], {
      filters: ["ready", "admins", "gpu"],
      sort: "user",
      match: "",
      policy: "slack",
      credential: "github",
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("alpha-claw");
  });

  it("resolves user lookup by sandbox and formats user detail", () => {
    const user = bridge.resolveUserLookup("veyonce-claw");
    expect(user?.sandboxName).toBe("veyonce-claw");

    const text = bridge.buildShowUserText({
      slackUserId: "U1",
      slackDisplayName: "Alice",
      sandboxName: "alice-claw",
      enabled: true,
      roles: ["user", "admin"],
      timezone: "UTC",
      githubUser: "alicehub",
      createdAt: "2026-03-28T10:00:00.000Z",
      credentialsDir: path.join(os.tmpdir(), "missing-creds"),
    });

    expect(text).toContain("*User Detail*");
    expect(text).toContain("Alice (`U1`)");
    expect(text).toContain("Claw: `alice-claw`");
    expect(text).toContain("Roles: user, admin");
    expect(text).toContain("Claude Auth:");
  });

  it("formats admin help text with delete restart guidance", () => {
    const text = bridge.formatAdminHelp();
    expect(text).toContain("*Admin Commands*");
    expect(text).toContain("`!admin-help`");
    expect(text).toContain("Delete confirmations expire after 5 minutes");
    expect(text).toContain("lost if the bridge restarts");
  });

  it("builds a Slack table payload for claw inventory", () => {
    const payload = bridge.buildShowClawsTablePayload();
    expect(payload).toHaveProperty("text");
    if (payload.attachments) {
      expect(payload.attachments[0].blocks[0].type).toBe("table");
      expect(payload.attachments[0].blocks[0].rows[0][0].text).toBe("Claw");
    }
  });

  it("builds filtered show-claws payload", () => {
    const payload = bridge.buildShowClawsPayload("!show-claws ready sort=status");
    expect(payload).toHaveProperty("text");
  });
});
