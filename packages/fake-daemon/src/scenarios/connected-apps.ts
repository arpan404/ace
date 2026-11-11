import { ThreadId, WorkspaceId } from "@ace/protocol";
import type { FakeDaemon } from "../daemon.ts";
import { endTurn, message, rootAgent, turn } from "./facts.ts";

const day = 24 * 60 * 60_000;

/**
 * `?fakeWorld=connected-apps`: outside MCP clients on this machine (ADR 0117). Claude has a
 * grant and started a thread, sending its first message for the person; a terminal agent
 * enrolled with `ace mcp enroll`; an old grant was revoked. ChatGPT is asking to sign in and
 * Claude is using the screen, so the notices show.
 */
export function seedConnectedApps(daemon: FakeDaemon, now: number): void {
  const started = "thread-outside-claude";
  daemon.createThread(
    {
      id: started,
      workspaceId: "ace",
      title: "Summarise yesterday's failing checks",
      provider: "claude",
      hasSentMessage: true,
    },
    2 * 3_600_000,
  );
  daemon.updateThread(
    started,
    { startedByClient: { kind: "mcp_client", grantId: "grant-claude", name: "Claude" } },
    2 * 3_600_000,
  );
  daemon.apply(
    started,
    [
      rootAgent("claude"),
      turn("root"),
      {
        type: "item.upsert",
        agent: "root",
        item: "ask",
        draft: {
          type: "message",
          role: "user",
          complete: true,
          parts: [{ type: "text", text: "Summarise yesterday's failing checks on main." }],
          origin: { kind: "person", client: { grantId: "grant-claude", name: "Claude" } },
        },
      },
      message("root", "answer", "assistant", "Two checks failed: the size check and a flaky test."),
      endTurn("root"),
    ],
    2 * 3_600_000,
  );
  const outside = daemon.outside;
  outside.grants = [
    {
      id: "grant-claude",
      clientKind: "cimd",
      clientId: "https://claude.ai/oauth/mcp-client.json",
      name: "Claude",
      domain: "claude.ai",
      scopes: ["threads:read", "threads:start", "threads:message", "computer"],
      projects: "all",
      createdAt: now - 3 * day,
      expiresAt: now + 27 * day,
      lastUsedAt: now - 4 * 60_000,
      revokedAt: null,
      approvedBy: "device-desktop",
      started: [ThreadId.parse(started)],
      messaged: [ThreadId.parse(started)],
    },
    {
      id: "grant-cli",
      clientKind: "cli",
      clientId: "cli-build-bot",
      name: "build-bot",
      domain: null,
      scopes: ["threads:read", "threads:stop"],
      projects: [WorkspaceId.parse("ace")],
      createdAt: now - 10 * day,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      approvedBy: "local",
      started: [],
      messaged: [],
    },
    {
      id: "grant-old",
      clientKind: "dcr",
      clientId: "dcr-old",
      name: "Notes helper",
      domain: null,
      scopes: ["threads:read"],
      projects: "all",
      createdAt: now - 40 * day,
      expiresAt: null,
      lastUsedAt: now - 20 * day,
      revokedAt: now - 6 * day,
      approvedBy: "device-desktop",
      started: [],
      messaged: [],
    },
  ];
  outside.endpoints = [
    { path: "local", url: "http://127.0.0.1:47811/mcp", on: true },
    {
      path: "tailscale",
      url: null,
      on: true,
      problem: "This machine has no ts.net certificate yet. Turn on HTTPS in Tailscale.",
    },
    { path: "relay", url: "https://relay.acehq.dev/m/host-studio/mcp", on: true },
    { path: "custom", url: null, on: false },
  ];
  outside.ask({
    requestId: "request-chatgpt",
    clientName: "ChatGPT",
    domain: "chatgpt.com",
    scopes: ["threads:read", "threads:start", "browser"],
    matchCode: "4F7K",
    expiresAt: now + 10 * 60_000,
    redirectHost: "chatgpt.com",
    redirectKind: "web",
  });
  outside.useScreen([{ grantId: "grant-claude", name: "Claude", apps: ["Simulator"] }]);
}
