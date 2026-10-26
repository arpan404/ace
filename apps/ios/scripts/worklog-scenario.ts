import {
  ScenarioPlayer,
  facts,
  interruptedTurn,
  oneTurnWork,
  replayCursor,
  watchingRelay,
  type FakeDaemon,
} from "@ace/fake-daemon";

/*
 * Work logs for the spike daemon, the same scenarios the web's transcript tests play: a turn
 * working through grouped steps, one settled into "Worked for" with prose between its steps, a
 * group of background commands, parallel steps with one in flight, an interrupted turn and a
 * failed one. No provider process runs.
 */

const minute = 60_000;

export function seedWorkLogs(daemon: FakeDaemon): void {
  // Working: a thought, then a group of reads, edits and commands under "Working for".
  new ScenarioPlayer(daemon, replayCursor("ios-log-live"), { agoMs: 4 * minute }).runThrough(
    "worked",
  );
  // Settled: one "Worked for" whose steps hold what the agent said between them.
  new ScenarioPlayer(daemon, oneTurnWork("ios-log-done"), { agoMs: 6 * minute }).runThrough(
    "answered",
  );
  // Two background commands, one still running.
  new ScenarioPlayer(daemon, watchingRelay("ios-log-background"), {
    agoMs: 3 * minute,
  }).runUntilBlocked();
  // Three commands started back to back, then a restart interrupting the turn.
  new ScenarioPlayer(daemon, interruptedTurn("ios-log-interrupted"), {
    agoMs: 8 * minute,
  }).runUntilBlocked();
  parallel(daemon);
  failed(daemon);
  stopped(daemon);
}

/** A slow command in flight beside a quick one that finished, after a thought. */
function parallel(daemon: FakeDaemon): void {
  daemon.createThread(
    { id: "ios-log-parallel", workspaceId: "ace", title: "Parallel builds", provider: "claude" },
    2 * minute,
  );
  daemon.apply("ios-log-parallel", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Check both builds"),
    {
      type: "item.upsert",
      agent: "root",
      item: "thought",
      draft: {
        type: "reasoning",
        complete: true,
        text: "The slow build can run alongside the quick check.",
      },
    },
    facts.tool("root", "slow", {
      kind: "shell",
      title: "slow",
      detail: { kind: "shell", command: "bun run slow" },
    }),
    facts.tool("root", "quick", {
      kind: "shell",
      title: "quick",
      detail: { kind: "shell", command: "bun run quick" },
    }),
    facts.toolDone("root", "quick"),
  ]);
}

/** A turn the provider failed, with its reviewed words and the provider's own in Details. */
function failed(daemon: FakeDaemon): void {
  daemon.createThread(
    {
      id: "ios-log-failed",
      workspaceId: "ace",
      title: "Greeting",
      provider: "cursor",
      execution: { provider: "cursor", model: "composer-2.5", options: {} },
    },
    5 * minute,
  );
  daemon.apply("ios-log-failed", [
    facts.rootAgent("cursor"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "yo"),
    {
      type: "item.upsert",
      agent: "root",
      item: "run-failed",
      draft: {
        type: "notice",
        level: "error",
        diagnostic: true,
        code: "cursor.run-failed",
        text: "Increase limits for faster responses",
        complete: true,
      },
    },
    facts.endTurn("root", "failed"),
  ]);
}

/** A turn the person stopped after two steps. */
function stopped(daemon: FakeDaemon): void {
  daemon.createThread(
    { id: "ios-log-stopped", workspaceId: "ace", title: "Rename the config", provider: "codex" },
    7 * minute,
  );
  daemon.apply("ios-log-stopped", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Rename relay.config to relay.toml"),
    facts.tool("root", "read", {
      kind: "file.read",
      title: "read",
      detail: { kind: "file.read", path: "relay.config" },
    }),
    facts.toolDone("root", "read"),
    facts.tool("root", "move", {
      kind: "shell",
      title: "move",
      detail: { kind: "shell", command: "git mv relay.config relay.toml" },
    }),
    facts.toolDone("root", "move"),
    facts.endTurn("root", "interrupted"),
  ]);
}
