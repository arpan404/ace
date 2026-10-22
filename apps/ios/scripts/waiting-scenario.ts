import { facts, type FakeDaemon } from "@ace/fake-daemon";

/*
 * A thread whose main agent only waits, for the spike daemon: its turn has ended while two
 * subagents still work and a command it started runs in the background, so the composer's strip
 * reads "Waiting for 2 subagents · 1 command running" with its Stop. No provider process runs.
 */

type Details = (branch: string) => Record<string, unknown>;
const minute = 60_000;

export function waitingScenario(daemon: FakeDaemon, details: Details): void {
  daemon.createThread(
    {
      id: "ios-waiting",
      workspaceId: "ace",
      title: "Dedupe thread events after reconnect",
      provider: "claude",
      details: details("fix/replay-dedupe"),
    },
    12 * minute,
  );
  daemon.apply(
    "ios-waiting",
    [
      facts.rootAgent("claude"),
      facts.turn("root"),
      facts.message(
        "root",
        "ask",
        "user",
        "After a daemon restart the client shows the last 40 events twice. Fix it with a regression test, and use subagents to audit the other reconnect paths.",
      ),
      facts.tool("root", "read-replay", {
        kind: "file.read",
        title: "Read replay.ts",
        detail: { kind: "file.read", path: "apps/daemon/src/replay.ts" },
      }),
      facts.toolDone("root", "read-replay"),
    ],
    10 * minute,
  );
  daemon.apply(
    "ios-waiting",
    [
      facts.message(
        "root",
        "plan",
        "assistant",
        [
          "The daemon replays from the start of the thread instead of from the last event the client acknowledged. Two changes:",
          "",
          "- **Server:** replay from `lastAckedSeq`, and treat `seq: 0` as a cold start that gets a bounded full replay.",
          "- **Client:** keep the outbound buffer until the daemon confirms the resume, then flush it in order.",
          "",
          "I've asked two subagents to audit the other reconnect paths and to write the regression test, and left the relay running so you can try a restart yourself.",
        ].join("\n"),
      ),
      facts.tool("root", "spawn-audit", {
        kind: "agent.spawn",
        title: "Audit reconnect paths",
        detail: { kind: "agent.spawn", description: "Audit reconnect paths", childAgent: "audit" },
      }),
      facts.subagent("claude", "audit", "reconnect-audit", "spawn-audit"),
      facts.turn("audit", "spawn"),
      facts.tool("root", "spawn-test", {
        kind: "agent.spawn",
        title: "Write the regression test",
        detail: {
          kind: "agent.spawn",
          description: "Write the regression test",
          childAgent: "test",
        },
      }),
      facts.subagent("claude", "test", "regression-test", "spawn-test"),
      facts.turn("test", "spawn"),
      facts.tool("root", "relay", {
        kind: "shell",
        title: "Run the relay",
        detail: { kind: "shell", command: "bun run dev:relay" },
      }),
      {
        type: "background.started",
        agent: "root",
        task: "relay",
        item: "relay",
        kind: "shell",
        title: "bun run dev:relay",
        stoppable: true,
      },
      facts.endTurn("root"),
    ],
    7 * minute,
  );
}
