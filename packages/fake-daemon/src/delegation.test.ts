import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { FakeDaemon, ScenarioPlayer, delegatedDocs, delegatedDocsIds } from "./index.ts";

test("the delegation scenario exposes a running card before showing settled results", () => {
  const daemon = new FakeDaemon({ clock: () => 1000000 });
  const scenario = delegatedDocs()[0];
  if (!scenario) throw new Error("No scenario");
  const player = new ScenarioPlayer(daemon, scenario);
  player.runThrough("delegation-running");
  const running = daemon.snapshot({
    kind: "thread",
    threadId: ThreadId.parse(delegatedDocsIds.parent),
  });
  if (running?.kind !== "thread") throw new Error("Missing thread");
  expect(Object.values(running.items)).toContainEqual(
    expect.objectContaining({
      type: "delegation.started",
      childThreadId: delegatedDocsIds.child,
      phase: "running",
      complete: false,
    }),
  );
  player.runUntilBlocked();
  const settled = daemon.snapshot({
    kind: "thread",
    threadId: ThreadId.parse(delegatedDocsIds.parent),
  });
  if (settled?.kind !== "thread") throw new Error("Missing thread");
  expect(Object.values(settled.items)).toContainEqual(
    expect.objectContaining({
      type: "delegation.started",
      phase: "settled",
      complete: true,
      outcome: expect.objectContaining({ threadId: delegatedDocsIds.child, outcome: "completed" }),
    }),
  );
  expect(Object.values(settled.items)).toContainEqual(
    expect.objectContaining({
      type: "delegation.settled",
      origin: "ace",
      results: [
        expect.objectContaining({ threadId: delegatedDocsIds.child, outcome: "completed" }),
      ],
    }),
  );
});
