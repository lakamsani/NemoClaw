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
    expect(bridge.isAdminAuditCommand("!admin audit")).toBe(true);
    expect(bridge.isAdminHelpCommand("!admin-help")).toBe(true);
    expect(bridge.isAdminHelpCommand("!admin help")).toBe(true);
    expect(bridge.isShowClawsCommand("!show-claws")).toBe(true);
    expect(bridge.isShowClawsCommand("!show claws")).toBe(true);
    expect(bridge.isShowUserCommand("!show-user U123ABC")).toBe(true);
    expect(bridge.isShowUserCommand("!show user U123ABC")).toBe(true);
    expect(bridge.isAddClawCommand("!add-claw U123ABC Jane jane-claw janedoe")).toBe(true);
    expect(bridge.isAddClawCommand("!add claw U123ABC Jane jane-claw janedoe")).toBe(true);
    expect(bridge.isPurgeClawCommand("!purge-claw jane-claw")).toBe(true);
    expect(bridge.isPurgeClawCommand("!purge claw jane-claw")).toBe(true);
    expect(bridge.isDeleteClawCommand("!delete-claw jane-claw")).toBe(true);
    expect(bridge.isDeleteClawCommand("!delete claw jane-claw")).toBe(true);
    expect(bridge.isConfirmDeleteClawCommand("!confirm-delete-claw jane-claw")).toBe(true);
    expect(bridge.isConfirmDeleteClawCommand("!confirm delete claw jane-claw")).toBe(true);
  });

  it("canonicalizes spaced admin commands and detects admin-like typos", () => {
    expect(bridge.canonicalizeAdminCommand("!show claws ready")).toBe("!show-claws ready");
    expect(bridge.canonicalizeAdminCommand("!confirm delete claw alice-claw")).toBe("!confirm-delete-claw alice-claw");
    expect(bridge.canonicalizeAdminCommand("!purge claw alice-claw")).toBe("!purge-claw alice-claw");
    expect(bridge.looksLikeAdminCommand("!show clawz")).toBe(true);
    expect(bridge.looksLikeAdminCommand("hello")).toBe(false);
  });

  it("recognizes known bang commands and rejects unknown ones", () => {
    expect(bridge.isKnownBangCommand("!show-claws")).toBe(true);
    expect(bridge.isKnownBangCommand("!purge-claw alice-claw")).toBe(true);
    expect(bridge.isKnownBangCommand("!setup help")).toBe(true);
    expect(bridge.isKnownBangCommand("!yahoo inbox")).toBe(true);
    expect(bridge.isKnownBangCommand("!wa inbox")).toBe(true);
    expect(bridge.isKnownBangCommand("!purgee-claw alice-claw")).toBe(false);
    expect(bridge.isKnownBangCommand("!some-random-command")).toBe(false);
  });

  it("builds actionable auth recovery guidance for per-user Claude OAuth", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-"));
    const credentialsDir = path.join(tempRoot, "credentials");
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(path.join(credentialsDir, "claude-credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oat01-test" },
    }));

    const text = bridge.buildAuthRecoveryMessage({ credentialsDir });
    expect(text).toContain("per-user Claude OAuth credentials");
    expect(text).toContain("!setup claude <fresh ~/.claude/.credentials.json>");
  });

  it("prefers a long-lived Claude token as the auth source", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-token-"));
    const credentialsDir = path.join(tempRoot, "credentials");
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(path.join(credentialsDir, "claude-oauth-token.txt"), "sk-ant-oat01-token");

    expect(bridge.describeClaudeCredentialSource({ credentialsDir })).toBe("per-user long-lived token");
    expect(bridge.buildAuthRecoveryMessage({ credentialsDir })).toContain("!setup claude-token <token>");
  });

  it("reports Claude auth as not configured when no per-user credentials exist", () => {
    expect(bridge.describeClaudeCredentialSource({
      credentialsDir: path.join(os.tmpdir(), "missing-per-user-claude-creds"),
    })).toBe("not configured");
  });

  it("builds a fallback agent command that skips Claude auth and exposes OpenAI routing env", () => {
    const cmd = bridge.buildAgentCommand("hello", "abc", {
      slackUserId: "U1",
      slackDisplayName: "Alice",
      roles: ["user"],
    }, {
      skipClaudeAuth: true,
    });
    expect(cmd).toContain("unset ANTHROPIC_API_KEY");
    expect(cmd).toContain("NEMOCLAW_SKIP_CLAUDE_AUTH=1");
    expect(cmd).toContain("export OPENAI_API_KEY=");
    expect(cmd).not.toContain("PYMODEL");
  });

  it("injects no-background execution rules into agent commands", () => {
    const cmd = bridge.buildAgentCommand("open a PR after tests pass", "abc", {
      slackUserId: "U1",
      slackDisplayName: "Alice",
      roles: ["user"],
    });
    expect(cmd).toContain("Do not start background Claude Code sessions");
    expect(cmd).toContain("Only report success after the requested work, tests, and PR creation are actually complete.");
    expect(cmd).toContain("User request: open a PR after tests pass");
  });

  it("detects long coding requests for isolated Claude jobs", () => {
    expect(bridge.isLikelyLongCodingRequest("resolve https://github.com/lakamsani/fare-finder/issues/14")).toBe(true);
    expect(bridge.isLikelyLongCodingRequest("migrate it to Go")).toBe(true);
    expect(bridge.isLikelyLongCodingRequest("what programming language is https://github.com/lakamsani/fare-finder")).toBe(false);
    expect(bridge.isLikelyLongCodingRequest("merge and close that PR")).toBe(false);
  });

  it("builds isolated Claude job commands with foreground execution", () => {
    const cmd = bridge.buildClaudeJobCommand("resolve issue 14", {
      slackUserId: "U1",
      slackDisplayName: "Alice",
    });
    expect(cmd).toContain("claude --permission-mode bypassPermissions --print");
    expect(cmd).toContain("This is a foreground coding job launched for a Slack user request.");
    expect(cmd).toContain("User request: resolve issue 14");
    expect(cmd).toContain("cd /sandbox/.openclaw/workspace");
  });

  it("keeps only the final completion block from long coding transcripts", () => {
    const raw = `
Now let me fetch the issue details and start the fix.
No GH_TOKEN configured in skills. Let me check...
gh CLI is available and authenticated. Let me fetch the issue:
Now commit and push:
PR is open at https://github.com/lakamsani/fare-finder/pull/16. Let me check if the CI triggered:
All tests pass :white_check_mark:
Done. Here's what was done to fix issue #14:
*PR: https://github.com/lakamsani/fare-finder/pull/16*
Added a full Go port under go/.
`;

    expect(bridge.filterAgentOutput(raw)).toBe([
      "*PR: https://github.com/lakamsani/fare-finder/pull/16*",
      "Added a full Go port under go/.",
    ].join("\n"));
  });

  it("parses generic email requests for Yahoo helper routing", () => {
    expect(bridge.parseYahooRequest("get pending personal tasks")).toBeNull();
    expect(bridge.parseYahooRequest("emails from my cpa")).toEqual({
      kind: "search",
      query: "my cpa",
      count: 10,
      year: null,
    });
    expect(bridge.parseYahooRequest("show 5 unread emails")).toEqual({
      kind: "inbox",
      count: 5,
      unread: true,
      year: null,
    });
    expect(bridge.parseYahooRequest("unable to pull email")).toEqual({
      kind: "inbox",
      count: 10,
      unread: false,
      year: null,
    });
    expect(bridge.parseYahooRequest("show cpa emails from this year")).toEqual({
      kind: "search",
      query: "cpa",
      count: 10,
      year: 2026,
    });
  });

  it("extracts email refinements from short follow-up prompts", () => {
    expect(bridge.extractMailRefinement("this year is 2026")).toEqual({ year: 2026 });
    expect(bridge.extractMailRefinement("for 2025")).toEqual({ year: 2025 });
    expect(bridge.extractMailRefinement("thanks")).toBeNull();
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
    fs.writeFileSync(path.join(credentialsDir, "gogcli", "config.json"), "{}");

    const configured = bridge.listConfiguredCredentials({ credentialsDir });

    expect(configured).toEqual(["GitHub", "Google (gogcli)"]);
  });

  it("expires and drops stale pending runs by age", () => {
    const now = 1_000_000;
    expect(bridge.shouldExpireLaunchingPendingRun({ startedAt: now - (3 * 60 * 1000), state: "launching" }, now)).toBe(true);
    expect(bridge.shouldExpireLaunchingPendingRun({ startedAt: now - (30 * 1000), state: "launching" }, now)).toBe(false);
    expect(bridge.shouldExpireLaunchingPendingRun({ startedAt: now - (3 * 60 * 1000), state: "running" }, now)).toBe(false);
    expect(bridge.shouldExpirePendingRun({ startedAt: now - (21 * 60 * 1000) }, now)).toBe(true);
    expect(bridge.shouldExpirePendingRun({ startedAt: now - (5 * 60 * 1000) }, now)).toBe(false);
    expect(bridge.shouldDropPendingRun({ startedAt: now - (7 * 60 * 60 * 1000) }, now)).toBe(true);
    expect(bridge.shouldDropPendingRun({ startedAt: now - (30 * 60 * 1000) }, now)).toBe(false);
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

  it("recognizes retry commands", () => {
    expect(bridge.isRetryCommand("retry")).toBe(true);
    expect(bridge.isRetryCommand("try again")).toBe(true);
    expect(bridge.isRetryCommand("retry that")).toBe(true);
    expect(bridge.isRetryCommand("retry my last git repos query")).toBe(true);
    expect(bridge.isRetryCommand("retry last request")).toBe(true);
    expect(bridge.isRetryCommand("retry latest freshrelease query")).toBe(false);
  });

  it("redacts sensitive values from responses", () => {
    const text = bridge.redactSensitiveText("token sk-ant-secret-value", {
      slackUserId: "U1",
      credentialsDir: path.join(os.tmpdir(), "unused-creds"),
    });
    expect(text).not.toContain("sk-ant-secret-value");
    expect(text).toContain("[REDACTED]");
  });

  it("converts raw sandbox/bootstrap failures into friendly user-facing text", () => {
    const text = bridge.sanitizeUserFacingResponse("Agent exited with code 1. [SECURITY] CAP_SETPCAP not available\nSetting up NemoClaw...");
    expect(text).toBe("I couldn't complete that request in the sandbox. Please try again.");
  });

  it("records and reuses the last non-retry user request", () => {
    bridge.recordLastUserRequest("U-last", "list my git repos changed this month");
    bridge.recordLastUserRequest("U-last", "retry");
    expect(bridge.getRecordedLastUserRequest("U-last")).toBe("list my git repos changed this month");
  });

  it("collapses multi-project Freshrelease output into one markdown table", () => {
    const merged = bridge.collapseFreshreleaseTables(`## BILLING
Epic type: Epic (epic, id=11)
| Key | Title | Assigned User | Current State | Created Date | Targeted Date | Updated |
|---|---|---|---|---|---|---|
| BILLING-1 | Billing Epic | Alice | Open | 2026-01-01 | 2026-02-01 | 2026-01-05 |

## SEARCH
Epic type: Epic (epic, id=11)
| Key | Title | Assigned User | Current State | Created Date | Targeted Date | Updated |
|---|---|---|---|---|---|---|
| SEARCH-1 | Search Epic | Bob | In Progress | 2026-01-03 | 2026-02-04 | 2026-01-06 |
`);
    expect(merged).toContain("| Project | Epic Type | Key | Title | Assigned User | Current State | Created Date | Targeted Date | Updated |");
    expect(merged).toContain("| BILLING | Epic (epic, id=11) | BILLING-1 | Billing Epic | Alice | Open | 2026-01-01 | 2026-02-01 | 2026-01-05 |");
    expect(merged).toContain("| SEARCH | Epic (epic, id=11) | SEARCH-1 | Search Epic | Bob | In Progress | 2026-01-03 | 2026-02-04 | 2026-01-06 |");
  });
});
