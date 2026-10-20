import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import type { OffshiftRunCard } from "@ace/protocol/offshift";
import { OffshiftView } from "@ace/protocol/offshift";
import { evalWorld, type EvalWorld } from "./evals/world.ts";
import { Store } from "./store.ts";

/** `offshift` through the real daemon and a real MCP client, read the way a model reads it. */
let world: EvalWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});
const Control = z.object({
  ok: z.boolean(),
  code: z.string().optional(),
  hint: z.string().optional(),
  data: z.unknown().optional(),
});

const start = {
  action: "start",
  runId: "login",
  requestId: "start-login",
  outcome: "The login page shows a helpful error",
  endpoint: "Verified local changes",
  criteria: [{ id: "error", description: "Bad password shows an error", requiredKinds: ["ui"] }],
};

it("an agent starts a run, records a check at the current revision and reads it back", async () => {
  world = await evalWorld({ browser: false });
  const { agent } = await world.agent({});
  const started = await agent.call("offshift", start);
  expect(started.failed, started.text).toBe(false);
  const view = OffshiftView.parse(Control.parse(started.data).data);
  expect(view.pending).toEqual([{ criterionId: "error", kind: "ui" }]);

  const recorded = await agent.call("offshift", {
    action: "evidence",
    runId: "login",
    requestId: "check-error",
    version: view.run.version,
    evidence: {
      criterionId: "error",
      kind: "ui",
      result: "pass",
      revision: view.revision,
      action: "Typed a wrong password and submitted",
      artifact: "screenshot://login-error",
      note: "The error appears under the field",
    },
  });
  expect(recorded.failed, recorded.text).toBe(false);

  const read = OffshiftView.parse(
    Control.parse((await agent.call("offshift", { action: "get", runId: "login" })).data).data,
  );
  expect(read.pending).toEqual([]);
  expect(read.run.evidence).toMatchObject([{ criterionId: "error", result: "pass" }]);
  expect(read.run.version).toBe(1);
});

it("each change publishes the run's card to the thread and its snapshot, and nothing else does, across a restart", async () => {
  world = await evalWorld({ browser: false });
  const { agent, threadId } = await world.agent({});
  const cards: OffshiftRunCard[] = [];
  world.store.subscribe((events) => {
    for (const event of events)
      if (event.threadId === threadId && event.payload.type === "offshift.updated")
        cards.push(event.payload.card);
  });
  const view = OffshiftView.parse(Control.parse((await agent.call("offshift", start)).data).data);
  expect(cards).toMatchObject([
    { id: "login", phase: "plan", version: 0, pending: [{ criterionId: "error", kind: "ui" }] },
  ]);

  // A lost-response retry, a read and a stale write change nothing, so they publish nothing.
  expect((await agent.call("offshift", start)).failed).toBe(false);
  await agent.call("offshift", { action: "get", runId: "login" });
  const stale = await agent.call("offshift", {
    action: "block",
    runId: "login",
    requestId: "stale",
    version: 7,
    note: "Need a test account",
  });
  expect(Control.parse(stale.data)).toMatchObject({ ok: false, code: "invalid" });
  expect(cards).toHaveLength(1);

  await agent.call("offshift", {
    action: "block",
    runId: "login",
    requestId: "block",
    version: view.run.version,
    note: "Need a test account",
  });
  expect(cards).toHaveLength(2);
  expect(cards[1]).toMatchObject({ blocker: "Need a test account", version: 1 });
  expect(world.store.snapshotThread(threadId).offshift).toEqual(cards[1]);

  const path = join(dirname(world.daemon.tokenPath), "events.sqlite");
  await world.close();
  world = undefined;
  const reopened = new Store(path);
  try {
    expect(reopened.snapshotThread(threadId).offshift).toEqual(cards[1]);
  } finally {
    reopened.close();
  }
});

it("a change missing its required fields is refused before anything is recorded", async () => {
  world = await evalWorld({ browser: false });
  const { agent } = await world.agent({});
  const refused = await agent.call("offshift", { action: "advance", runId: "login" });
  expect(refused.failed).toBe(true);
  expect(refused.text).toContain("requestId");
  const listed = await agent.call("offshift", { action: "list" });
  expect(Control.parse(listed.data).data).toEqual([]);
});

it("a workspace that is not a Git repository answers unavailable with a next step", async () => {
  world = await evalWorld({ browser: false });
  const project = world.store.getWorkspacePath(world.workspaceId);
  if (!project) throw new Error("Missing project");
  rmSync(join(project, ".git"), { recursive: true, force: true });
  const { agent } = await world.agent({});
  const result = await agent.call("offshift", start);
  const control = Control.parse(result.data);
  expect(control).toMatchObject({ ok: false, code: "unavailable" });
  expect(control.hint).toContain("not a readable Git repository");
});
