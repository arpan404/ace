import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import type { OffshiftRunCard } from "@ace/protocol/offshift";
import { OffshiftPlaybooks, OffshiftView } from "@ace/protocol/offshift";
import type { ThreadId } from "@ace/protocol";
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
  expect(refused.text).toContain("advance needs version");
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

const childIds = (value: unknown) =>
  z.object({ threadIds: z.array(z.string()) }).parse(value).threadIds;
const view = (value: unknown) => OffshiftView.parse(Control.parse(value).data);
const restore = {
  action: "start",
  runId: "restore",
  outcome: "A deleted item can be restored",
  endpoint: "Verified local changes",
  criteria: [
    {
      id: "restore",
      description: "Restore brings the item back",
      requiredKinds: ["source"],
      independent: true,
    },
  ],
};
const sourceCheck = (revision: string) => ({
  criterionId: "restore",
  kind: "source",
  result: "pass",
  revision,
  action: "Read the restore diff",
  artifact: "review://restore",
  note: "The handler reinserts the row",
});

it("a delegated child on another provider records the independent check on its parent's run, and only that pass counts", async () => {
  world = await evalWorld({ browser: false });
  const { agent: owner, threadId: ownerId } = await world.agent({});
  const started = view((await owner.call("offshift", restore)).data);
  const own = await owner.call("offshift", {
    action: "evidence",
    runId: "restore",
    version: started.run.version,
    evidence: sourceCheck(started.revision),
  });
  const mine = view(own.data);
  // The owner's own pass stays pending, and next says how to get an independent one.
  expect(mine.pending).toEqual([{ criterionId: "restore", kind: "source", needs: "independent" }]);

  const delegated = await owner.call("delegate", {
    tasks: [
      { requestId: "verify", task: "Review restore", role: "review-restore", provider: "claude" },
    ],
  });
  expect(delegated.failed, delegated.text).toBe(false);
  const [childId] = childIds(Control.parse(delegated.data).data ?? delegated.data);
  if (!childId) throw new Error("No child started");
  const { agent: child } = await world.attach(childId as ThreadId);
  const read = view(
    (await child.call("offshift", { action: "get", runId: "restore", runOwner: ownerId })).data,
  );
  const recorded = await child.call("offshift", {
    action: "evidence",
    runId: "restore",
    runOwner: ownerId,
    version: read.run.version,
    evidence: sourceCheck(read.revision),
  });
  expect(recorded.failed, recorded.text).toBe(false);
  const after = view((await owner.call("offshift", { action: "get", runId: "restore" })).data);
  expect(after.pending).toEqual([]);
  expect(after.run.evidence).toMatchObject([{ by: { threadId: childId, provider: "claude" } }]);
  // A descendant only records evidence; it cannot move the owner's run.
  const advance = await child.call("offshift", {
    action: "advance",
    runId: "restore",
    runOwner: ownerId,
    version: after.run.version,
    phase: "implement",
    note: "Not mine to move",
  });
  expect(Control.parse(advance.data)).toMatchObject({ ok: false, code: "invalid" });
});

it("a thread that did not descend from the run's owner cannot read or record on its run", async () => {
  world = await evalWorld({ browser: false });
  const { agent: owner, threadId: ownerId } = await world.agent({});
  const started = view((await owner.call("offshift", restore)).data);
  const { agent: stranger } = await world.agent({ prompt: "an unrelated task" });
  const read = await stranger.call("offshift", {
    action: "get",
    runId: "restore",
    runOwner: ownerId,
  });
  expect(Control.parse(read.data)).toMatchObject({ ok: false, code: "forbidden" });
  const record = await stranger.call("offshift", {
    action: "evidence",
    runId: "restore",
    runOwner: ownerId,
    version: started.run.version,
    evidence: sourceCheck(started.revision),
  });
  expect(Control.parse(record.data)).toMatchObject({ ok: false, code: "forbidden" });
  const after = view((await owner.call("offshift", { action: "get", runId: "restore" })).data);
  expect(after.run.evidence).toEqual([]);
});

it("delegate with runRole runs the child as the run's role or the project default, and task fields win", async () => {
  world = await evalWorld({ browser: false });
  const { agent, threadId } = await world.agent({});
  expect(world.store.getThread(threadId)?.provider).toBe("codex");
  await agent.call("offshift", {
    ...restore,
    roles: { verify: { provider: "claude", effort: "high" } },
  });
  const project = await agent.call("offshift", {
    action: "roles",
    scope: "project",
    roles: { review: { provider: "claude" } },
  });
  expect(Control.parse(project.data)).toMatchObject({
    ok: true,
    data: { scope: "project", roles: { review: { provider: "claude" } } },
  });
  const started = await agent.call("delegate", {
    tasks: [
      { requestId: "by-role", task: "Verify restore", role: "verify-restore", runRole: "verify" },
      {
        requestId: "by-project",
        task: "Review restore",
        role: "review-restore",
        runRole: "review",
      },
      {
        requestId: "explicit",
        task: "Verify restore on codex",
        role: "verify-restore-codex",
        runRole: "verify",
        provider: "codex",
      },
    ],
  });
  expect(started.failed, started.text).toBe(false);
  const ids = childIds(Control.parse(started.data).data ?? started.data);
  expect(ids.map((id) => world?.store.getThread(id as ThreadId)?.provider)).toEqual([
    "claude",
    "claude",
    "codex",
  ]);
  // A role set nowhere is refused with the call that sets it, never run on another provider.
  const unset = await agent.call("delegate", {
    tasks: [
      { requestId: "unset", task: "Plan restore", role: "plan-restore", runRole: "judgment" },
    ],
  });
  expect(unset.failed).toBe(true);
  expect(unset.text).toContain("is not set on your active Offshift run");
});

it("an agent picks a playbook from the catalogue, starts from it, and marks steps before leaving a phase", async () => {
  world = await evalWorld({ browser: false });
  const { agent } = await world.agent({});
  const catalogue = Control.parse((await agent.call("offshift", { action: "playbooks" })).data);
  expect(catalogue.ok).toBe(true);
  const playbooks = OffshiftPlaybooks.parse(catalogue.data).playbooks;
  expect(playbooks.map((item) => item.id)).toEqual([
    "fix",
    "feature",
    "refactor",
    "perf",
    "investigate",
    "ui",
    "land",
  ]);

  const started = view((await agent.call("offshift", { ...start, playbook: "fix" })).data);
  expect(started.run.playbook).toBe("fix");
  expect(started.next).toContain("Step `reproduce`");

  const early = await agent.call("offshift", {
    action: "advance",
    runId: "login",
    version: started.run.version,
    phase: "implement",
    note: "Planned",
  });
  expect(Control.parse(early.data)).toMatchObject({ ok: false, code: "invalid" });
  expect(Control.parse(early.data).hint).toContain("Finish plan first");

  const done = view(
    (
      await agent.call("offshift", {
        action: "step",
        runId: "login",
        version: started.run.version,
        stepId: "reproduce",
        state: "done",
        note: "Saw no error under the field",
      })
    ).data,
  );
  const unexplained = await agent.call("offshift", {
    action: "step",
    runId: "login",
    version: done.run.version,
    stepId: "root-cause",
    state: "skipped",
  });
  expect(Control.parse(unexplained.data).hint).toContain("needs a note with the reason");
  const skipped = view(
    (
      await agent.call("offshift", {
        action: "step",
        runId: "login",
        version: done.run.version,
        stepId: "root-cause",
        state: "skipped",
        note: "The reproduction shows the missing handler",
      })
    ).data,
  );
  const advanced = view(
    (
      await agent.call("offshift", {
        action: "advance",
        runId: "login",
        version: skipped.run.version,
        phase: "implement",
        note: "Planned",
      })
    ).data,
  );
  expect(advanced.run.phase).toBe("implement");
  expect(advanced.next).toContain("Step `failing-test`");
});
