import { expect, test } from "vitest";
import { FakeDaemon } from "./daemon.ts";
import { ScenarioPlayer } from "./scenario.ts";
import { workbench } from "./scenarios/workbench.ts";

test("the workbench leaves every thread in the state the Home list design shows", () => {
  let now = 0;
  const daemon = new FakeDaemon({ clock: () => ++now });
  for (const scenario of workbench()) new ScenarioPlayer(daemon, scenario).runUntilBlocked();
  const view = daemon.snapshot({ kind: "threads" });
  if (view?.kind !== "threads") throw new Error("expected the thread list");
  const states = Object.fromEntries(
    Object.values(view.threads).map((thread) => [thread.title, thread.status.state]),
  );
  expect(states).toEqual({
    "Retry budget for app-server restarts": "needs_you",
    "Approval sheet loses its state on rotate": "needs_you",
    "Partial refunds double-count tax": "needs_you",
    "Dedupe thread events after reconnect": "working",
    "Rewrite the install page for the daemon": "working",
    "Invoice PDF locale fallback": "failed",
    "Backpressure on broadcast fan-out": "waiting",
    "Bump Codex app-server to 0.48": "done",
  });
});
