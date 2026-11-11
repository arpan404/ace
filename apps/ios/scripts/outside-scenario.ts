import { facts, type FakeDaemon } from "@ace/fake-daemon";
import { OutsideGrantEntry } from "@ace/protocol";

/*
 * Outside apps on the fixture's machine (ADR 0117): two connected apps and an ended one for
 * Settings › Connected apps, and a thread Claude started. `POST /review/outside` stages the
 * rest: `ask` opens a sign-in request (the approval sheet), `screen` has Claude use the
 * screen (the "Claude is using this Mac" line), `clear` ends both.
 */

const hour = 60 * 60_000;

export function seedOutside(daemon: FakeDaemon, now: number): void {
  daemon.outside.grants = [
    OutsideGrantEntry.parse({
      id: "grant-claude",
      clientKind: "cimd",
      clientId: "https://claude.ai/oauth/mcp-client.json",
      name: "Claude",
      domain: "claude.ai",
      scopes: ["threads:read", "threads:start", "threads:message", "computer"],
      projects: "all",
      createdAt: now - 3 * 24 * hour,
      expiresAt: now + 27 * 24 * hour,
      lastUsedAt: now - 2 * hour,
      revokedAt: null,
      approvedBy: "ios-spike-device",
      started: ["ios-outside-started"],
      messaged: [],
    }),
    OutsideGrantEntry.parse({
      id: "grant-ci",
      clientKind: "cli",
      clientId: "ace-mcp-enroll",
      name: "Release bot",
      domain: null,
      scopes: ["threads:read"],
      projects: ["ace"],
      createdAt: now - 10 * 24 * hour,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      approvedBy: "local",
      started: [],
      messaged: [],
    }),
    OutsideGrantEntry.parse({
      id: "grant-old",
      clientKind: "dcr",
      clientId: "dcr-0001",
      name: "ChatGPT",
      domain: null,
      scopes: ["threads:read", "threads:start"],
      projects: "all",
      createdAt: now - 40 * 24 * hour,
      expiresAt: now - 10 * 24 * hour,
      lastUsedAt: now - 11 * 24 * hour,
      revokedAt: null,
      approvedBy: "ios-spike-device",
      started: [],
      messaged: [],
    }),
  ];
  daemon.createThread({
    hasSentMessage: true,
    id: "ios-outside-started",
    workspaceId: "ace",
    title: "Summarise this week's merged pull requests",
    provider: "claude",
    startedByClient: { kind: "mcp_client", grantId: "grant-claude", name: "Claude" },
  });
  daemon.apply("ios-outside-started", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.endTurn("root"),
  ]);
}

let asks = 0;
export function outsideScenario(daemon: FakeDaemon, kind: "ask" | "screen" | "clear"): void {
  if (kind === "ask")
    daemon.outside.ask({
      requestId: `ios-outside-ask-${++asks}`,
      clientName: "Claude",
      domain: "claude.ai",
      scopes: ["threads:read", "threads:start", "threads:message", "browser"],
      matchCode: "7KQ2XM",
      expiresAt: Date.now() + 10 * 60_000,
    });
  else if (kind === "screen")
    daemon.outside.useScreen([{ grantId: "grant-claude", name: "Claude", apps: ["Safari"] }]);
  else {
    daemon.outside.access = [];
    daemon.outside.useScreen([]);
  }
}
