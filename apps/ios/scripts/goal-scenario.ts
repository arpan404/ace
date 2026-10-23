import { facts, type FakeDaemon } from "@ace/fake-daemon";

/*
 * A thread pursuing a goal between turns: the phone's pill shows "Pursuing goal", and its sheet
 * the objective, why it isn't met yet and its progress, with Pause and Clear (a Codex goal, which
 * ace sets natively). No provider process runs.
 */

const minute = 60_000;

export function seedGoal(
  daemon: FakeDaemon,
  details: (branch: string) => Record<string, unknown>,
): void {
  daemon.createThread(
    {
      hasSentMessage: true,
      id: "ios-goal",
      workspaceId: "ace",
      title: "Make the checkout suite pass",
      provider: "codex",
      details: details("fix/checkout-suite"),
    },
    40 * minute,
  );
  daemon.apply(
    "ios-goal",
    [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.message("root", "ask", "user", "/goal every test in packages/checkout passes"),
      facts.message(
        "root",
        "answer",
        "assistant",
        "Two of the five failing tests pass now. The refund tests still read the clock directly; I'll inject it next.",
      ),
      facts.endTurn("root"),
    ],
    12 * minute,
  );
  daemon.updateThread("ios-goal", {
    goal: {
      objective: "every test in packages/checkout passes",
      status: "active",
      tokensUsed: 182_000,
      timeUsedSeconds: 1_920,
      checks: 3,
      lastReason: "the two refund tests still fail on a fixed clock",
    },
  });
  // A second thread with its own goal, so a sheet left on one can be shown never to reach the other.
  daemon.createThread(
    {
      hasSentMessage: true,
      id: "ios-goal-other",
      workspaceId: "ace",
      title: "Keep the docs build green",
      provider: "codex",
      details: details("docs/build"),
    },
    50 * minute,
  );
  daemon.apply(
    "ios-goal-other",
    [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")],
    20 * minute,
  );
  daemon.updateThread("ios-goal-other", {
    goal: { objective: "the docs build passes on every push", status: "active" },
  });
}
