import { FakeDaemon, ScenarioPlayer, facts } from "@ace/fake-daemon";
import { HostId, ThreadId } from "@ace/protocol";

const child = ThreadId.parse("build-server-sweep");
const buildServer = HostId.parse("build-server");

/**
 * `?fakeWorld=cross-device`, continued: a Claude thread on This Mac (on its "Work" account) that
 * runs a Claude subagent here and delegates a sweep to the build server, where the child runs on
 * that machine's second Codex account, "Release". Their rows wear those accounts' badges; the
 * build server's is read from the build server.
 */
export function seedMachineChildren(daemon: FakeDaemon, server: FakeDaemon): void {
  const codex = server.services.accounts.find((account) => account.provider === "codex");
  if (codex)
    server.services.accounts = [
      ...server.services.accounts,
      { ...codex, id: "codex-release", label: "Release", shortLabel: "R", isDefault: false },
    ];
  server.createThread({
    id: child,
    workspaceId: "relay",
    title: "Review-PR1641-daemon-sweep",
    provider: "codex",
    hasSentMessage: true,
    execution: { provider: "codex", model: "gpt-5.5", instanceId: "codex-release", options: {} },
  });
  new ScenarioPlayer(daemon, {
    thread: {
      id: "thread-machine-children",
      workspaceId: "relay",
      title: "Sweep the daemon before the release",
      provider: "claude",
      execution: { provider: "claude", instanceId: "claude-work", options: {} },
    },
    steps: [
      {
        kind: "facts",
        agoMs: 2 * 60_000,
        facts: [
          facts.rootAgent("claude", "/Users/dev/relay"),
          facts.turn("root"),
          facts.message(
            "root",
            "ask",
            "user",
            "Review PR 1641: sweep the daemon on the build server, and check the docs here.",
          ),
          facts.tool("root", "spawn-docs", {
            kind: "agent.spawn",
            title: "Check the docs",
            detail: { kind: "agent.spawn", childAgent: "docs" },
          }),
          facts.subagent("claude", "docs", "Check the docs", "spawn-docs"),
          facts.turn("docs", "spawn"),
          facts.message("docs", "docs-answer", "assistant", "The docs match the PR.", false),
          facts.endTurn("docs"),
          {
            type: "item.upsert",
            agent: "root",
            item: "build-delegation",
            draft: {
              type: "delegation.started",
              origin: "ace",
              childThreadId: child,
              provider: "codex",
              model: "gpt-5.5",
              title: "Review-PR1641-daemon-sweep",
              role: "Review",
              phase: "running",
              status: { state: "working", agents: 1 },
              updatedAt: 1,
              generation: 0,
              complete: false,
              outcome: null,
              machine: { machine: "build-server", name: "Build server", hostId: buildServer },
            },
          },
        ],
      },
    ],
  }).runUntilBlocked();
}
