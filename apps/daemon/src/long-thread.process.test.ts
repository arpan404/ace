import { expect, test } from "vitest";
import {
  Agent,
  AgentId,
  BackgroundTask,
  BackgroundTaskId,
  CommandId,
  DeviceId,
  InteractionId,
  ItemId,
  ThreadId,
  TurnsPageRequest,
  ItemsWindowRequest,
  ThreadSearchRequest,
  ThreadCatchUpRequest,
  ThreadReadStateRequest,
} from "@ace/protocol";
import { fixture as socketFixture } from "./socket-test-support.ts";
import { setup as remoteFixture } from "./remote-test-support.ts";
import {
  cleanups,
  root,
  device,
  storeFixture,
  userMessage,
  agentMessage,
  tool,
  start,
  end,
  turns,
  catchUp,
  window,
  approval,
} from "./long-thread-test-support.ts";

// Mutations: allocating ordinals from the retained tail; losing the pre-run message;
// failing to allocate automatic turns; inclusive page cursors. Not executed (tests run at merge).
test("root turn ordinals and pre-run messages survive restart and page around automatic turns", async () => {
  const f = storeFixture();
  f.store.appendEvents(
    f.thread.id,
    [{ type: "item.created", item: userMessage("first-input", "Investigate a multi-day task") }],
    20,
  );
  start(f.store, f.thread, "first", 30);
  f.store.appendEvents(
    f.thread.id,
    [{ type: "item.created", item: agentMessage("first-reply", "First outcome", "first") }],
    40,
  );
  end(f.store, f.thread, "first", 50);
  const firstEndSeq = f.store.headSeq();
  start(f.store, f.thread, "automatic", 60, "background_completion");
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: agentMessage("automatic-reply", "Background task result", "automatic"),
      },
    ],
    70,
  );
  end(f.store, f.thread, "automatic", 80);
  await f.restart();
  f.store.appendEvents(
    f.thread.id,
    [{ type: "item.created", item: userMessage("third-input", "Continue tomorrow") }],
    90,
  );
  start(f.store, f.thread, "third", 100);
  const latest = turns(f.store, f.thread, { limit: 2 });
  expect(latest.turns.map((turn) => turn.ordinal)).toEqual([2, 3]);
  expect(latest.before).toBe(2);
  const older = turns(f.store, f.thread, { before: latest.before ?? 0, limit: 2 });
  expect(older.turns.map((turn) => turn.ordinal)).toEqual([1]);
  expect(older.turns[0]).toMatchObject({
    initiatingMessagePreview: "Investigate a multi-day task",
    latestAgentMessagePreview: "First outcome",
    outcome: "completed",
  });
  expect(older.turns[0]?.endedAt).toBe(50);
  expect(older.turns[0]?.endSeq).toBe(firstEndSeq);
  expect(
    turns(f.store, f.thread, { after: 1, limit: 1 }).turns.map((turn) => turn.ordinal),
  ).toEqual([2]);
  expect(window(f.store, f.thread, { turnOrdinal: 1 }).items[0]?.id).toBe("first-input");
  expect(latest.ready).toBe(true);
});

// Mutations: treating item.updated as another tool, adding replaced file line totals,
// losing original-turn ownership after a later run starts. Not executed (tests run at merge).
test("authoritative late tool results replace counts and files in their original turn", () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 20);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool("command", "running", { kind: "shell", command: "build" }, "first"),
      },
      {
        type: "item.created",
        item: tool(
          "edit",
          "succeeded",
          {
            kind: "file.edit",
            changes: [
              {
                path: "src/main.ts",
                kind: "update",
                diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1,2 @@\n-old\n+new\n+second",
              },
            ],
          },
          "first",
        ),
      },
    ],
    30,
  );
  end(f.store, f.thread, "first", 40);
  start(f.store, f.thread, "second", 50);
  const replacement = tool(
    "command",
    "failed",
    { kind: "shell", command: "build", exitCode: 2 },
    "first",
  );
  f.store.appendEvents(
    f.thread.id,
    [
      { type: "item.updated", item: replacement },
      {
        type: "item.updated",
        item: tool(
          "edit",
          "succeeded",
          {
            kind: "file.edit",
            changes: [
              {
                path: "src/main.ts",
                kind: "update",
                diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+replacement",
              },
            ],
          },
          "first",
        ),
      },
      { type: "item.updated", item: replacement },
    ],
    60,
  );
  const [first, second] = turns(f.store, f.thread).turns;
  expect(first?.digest).toMatchObject({
    toolCounts: { shell: 1, "file.edit": 1 },
    commandsRun: 1,
    commandsFailed: 1,
    errors: 1,
    files: [{ path: "src/main.ts", added: 1, removed: 1 }],
    commands: [{ itemId: "command", command: "build", failed: true, exitCode: 2 }],
  });
  expect(second?.digest.commandsRun).toBe(0);
  expect(second?.digest.files).toEqual([]);
  expect(first?.endSeq).toBeGreaterThan(second?.startSeq ?? 0);
});

// Mutations: marking the turn completed from run.ended alone; ignoring children, approvals
// or live background tasks; inferring automatic review from missing device. Not executed (tests run at merge).
test("a root outcome stays unfinished until its child, approval and shell have all settled", () => {
  const f = storeFixture();
  start(f.store, f.thread, "root-run", 20);
  const child = AgentId.parse("child");
  const task = BackgroundTaskId.parse("shell-task");
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "agent.created",
        agent: Agent.parse({
          id: child,
          threadId: f.thread.id,
          parentId: root,
          origin: "provider_subagent",
          fidelity: "full",
          native: { provider: "codex" },
          cwd: f.home,
          status: { state: "working", activity: "tool" },
          background: true,
          createdAt: 21,
        }),
      },
      { type: "interaction.opened", interaction: approval(f.thread, "permission") },
      {
        type: "background_task.started",
        task: BackgroundTask.parse({
          id: task,
          agentId: root,
          kind: "shell",
          title: "Background build",
          status: "running",
          ambient: false,
          stoppable: true,
          startedAt: 21,
        }),
      },
    ],
    21,
  );
  end(f.store, f.thread, "root-run", 30);
  expect(turns(f.store, f.thread).turns[0]).toMatchObject({
    outcome: "completed",
    status: { state: "needs_you" },
    digest: { approvalsAsked: 1, approvalsPending: 1, subagentsStarted: 1, subagentsFinished: 0 },
  });
  expect(turns(f.store, f.thread).turns[0]?.endedAt).toBeUndefined();
  expect(catchUp(f.store, f.thread, { sinceSeq: 0 }).turnsCompleted).toBe(0);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "interaction.closed",
        interactionId: InteractionId.parse("permission"),
        state: "resolved",
        resolution: { kind: "approval", optionId: "allow" },
        closedAt: 40,
      },
    ],
    40,
  );
  expect(turns(f.store, f.thread).turns[0]?.digest).toMatchObject({
    approvalsAnswered: 1,
    approvalsAutoReviewed: 0,
    approvalsPending: 0,
  });
  expect(turns(f.store, f.thread).turns[0]?.status.state).toBe("working");
  f.store.appendEvents(
    f.thread.id,
    [{ type: "agent.status", agentId: child, status: { state: "idle" } }],
    50,
  );
  expect(turns(f.store, f.thread).turns[0]?.status).toEqual({
    state: "waiting",
    on: "background_task",
  });
  expect(catchUp(f.store, f.thread, { sinceSeq: 0 }).turnsCompleted).toBe(0);
  f.store.appendEvents(
    f.thread.id,
    [{ type: "background_task.updated", taskId: task, status: "completed", endedAt: 60 }],
    60,
  );
  const finished = turns(f.store, f.thread).turns[0];
  expect(finished?.status).toEqual({ state: "done" });
  expect(finished?.endedAt).toBe(60);
  expect(finished?.digest.subagentsFinished).toBe(1);
  expect(catchUp(f.store, f.thread, { sinceSeq: 0 }).turnsCompleted).toBe(1);
});

// Mutations: counting whole turns across a mid-turn cutoff; using inclusive cutoffs;
// dropping cumulative token deltas or pending approvals opened earlier. Not executed (tests run at merge).
test("catch-up counts exact changes after sequence and time cutoffs within an active turn", () => {
  const f = storeFixture();
  start(f.store, f.thread, "run", 20);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool(
          "before-command",
          "succeeded",
          { kind: "shell", command: "before", exitCode: 0 },
          "run",
        ),
      },
      {
        type: "item.created",
        item: tool(
          "before-file",
          "succeeded",
          {
            kind: "file.edit",
            changes: [
              {
                path: "shared.ts",
                kind: "update",
                diff: "--- a/shared.ts\n+++ b/shared.ts\n@@ -1 +1,2 @@\n-before\n+first\n+second",
              },
            ],
          },
          "run",
        ),
      },
      { type: "interaction.opened", interaction: approval(f.thread, "old-pending") },
      {
        type: "usage.updated",
        agentId: root,
        inputTokens: 100,
        outputTokens: 20,
        counterMode: "cumulative",
        usageScope: "agent",
      },
    ],
    100,
  );
  const boundary = f.store.headSeq();
  expect(catchUp(f.store, f.thread, { sinceSeq: boundary }).digest.commandsRun).toBe(0);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool(
          "after-command",
          "failed",
          { kind: "shell", command: "after", exitCode: 3 },
          "run",
        ),
      },
      {
        type: "item.created",
        item: tool(
          "after-file",
          "succeeded",
          {
            kind: "file.edit",
            changes: [
              {
                path: "shared.ts",
                kind: "update",
                diff: "--- a/shared.ts\n+++ b/shared.ts\n@@ -1 +1 @@\n-old\n+new",
              },
            ],
          },
          "run",
        ),
      },
      { type: "interaction.opened", interaction: approval(f.thread, "auto-approval") },
      {
        type: "interaction.closed",
        interactionId: InteractionId.parse("auto-approval"),
        state: "resolved",
        autoReviewed: true,
        resolution: { kind: "approval", optionId: "allow" },
        closedAt: 200,
      },
      {
        type: "usage.updated",
        agentId: root,
        inputTokens: 150,
        outputTokens: 50,
        counterMode: "cumulative",
        usageScope: "agent",
      },
      { type: "item.created", item: agentMessage("latest", "The background build failed", "run") },
    ],
    200,
  );
  const sequence = catchUp(f.store, f.thread, { sinceSeq: boundary });
  const time = catchUp(f.store, f.thread, { sinceTime: 100 });
  expect(sequence.digest).toMatchObject({
    toolCounts: { shell: 1 },
    commandsRun: 1,
    commandsFailed: 1,
    approvalsAsked: 1,
    approvalsAnswered: 1,
    approvalsAutoReviewed: 1,
    approvalsPending: 1,
    inputTokens: 50,
    outputTokens: 30,
    errors: 1,
    files: [{ path: "shared.ts", added: 1, removed: 1 }],
  });
  expect(time.digest).toEqual(sequence.digest);
  expect(sequence.latestAgentMessagePreview).toBe("The background build failed");
  expect(catchUp(f.store, f.thread, { sinceTime: 200 }).digest).toMatchObject({
    commandsRun: 0,
    approvalsAsked: 0,
    approvalsPending: 1,
  });
});

// Mutations: advancing derived state outside the canonical transaction or leaving mutable
// counter caches populated after rollback. Not executed (tests run at merge).
test("rolled-back canonical writes cannot advance turn summaries or catch-up counters", () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 20);
  const head = f.store.headSeq();
  const before = turns(f.store, f.thread);
  expect(() =>
    f.store.atomic(() => {
      f.store.appendEvents(
        f.thread.id,
        [
          {
            type: "item.created",
            item: tool(
              "rolled-back-command",
              "failed",
              { kind: "shell", command: "must never appear", exitCode: 1 },
              "first",
            ),
          },
        ],
        30,
      );
      throw new Error("Abort transaction");
    }),
  ).toThrow("Abort transaction");
  expect(f.store.headSeq()).toBe(head);
  expect(turns(f.store, f.thread)).toEqual(before);
  expect(catchUp(f.store, f.thread, { sinceSeq: head }).digest).toMatchObject({
    commandsRun: 0,
    commandsFailed: 0,
    errors: 0,
  });
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool(
          "committed-command",
          "succeeded",
          { kind: "shell", command: "visible", exitCode: 0 },
          "first",
        ),
      },
    ],
    40,
  );
  expect(turns(f.store, f.thread).turns[0]?.digest.commands).toEqual([
    { itemId: "committed-command", command: "visible", failed: false, exitCode: 0 },
  ]);
});

// Mutations: confusing host sequence gaps with item gaps, keeping deleted targets or failing
// to fall back to the last item. Not executed (tests run at merge).
test("item windows resolve deleted targets and both thread boundaries without paging from the tail", () => {
  const f = storeFixture();
  const events = f.store.appendEvents(
    f.thread.id,
    [
      { type: "item.created", item: agentMessage("first") },
      { type: "item.created", item: agentMessage("deleted") },
      { type: "thread.updated", title: "Sequence gap" },
      { type: "item.created", item: agentMessage("third") },
      { type: "item.created", item: agentMessage("last") },
    ],
    20,
  );
  const deleted = events.find(
    (event) => event.payload.type === "item.created" && event.payload.item.id === "deleted",
  );
  const third = events.find(
    (event) => event.payload.type === "item.created" && event.payload.item.id === "third",
  );
  if (!deleted || !third) throw new Error("Missing item events");
  f.store.appendEvents(
    f.thread.id,
    [{ type: "item.deleted", itemId: ItemId.parse("deleted") }],
    30,
  );
  const middle = window(f.store, f.thread, { aroundSeq: deleted.seq }, 1, 1);
  expect(middle.items.map((item) => item.id)).toEqual(["first", "third", "last"]);
  expect(middle.targetSeq).toBe(third.seq);
  expect(middle.itemsBefore).toBeNull();
  expect(middle.itemsAfter).toBeNull();
  const first = window(f.store, f.thread, { aroundSeq: 0 });
  expect(first.items.map((item) => item.id)).toEqual(["first"]);
  expect(first.itemsBefore).toBeNull();
  expect(first.itemsAfter).toBeGreaterThan(0);
  const last = window(f.store, f.thread, { aroundSeq: f.store.headSeq() + 100 });
  expect(last.items.map((item) => item.id)).toEqual(["last"]);
  expect(last.itemsAfter).toBeNull();
  expect(last.itemsBefore).toBeGreaterThan(0);
});

// Mutations: dropping the target to fit older items, treating an oversized neighbor as a
// fatal target error or returning a noncontiguous interval. Not executed (tests run at merge).
test("byte-limited item windows retain the target and stop at an oversized neighbor", () => {
  const f = storeFixture();
  const huge = "x".repeat(1100 * 1024);
  const events = f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool("oversized-before", "succeeded", { kind: "shell", command: huge }),
      },
      { type: "item.created", item: agentMessage("target", "The jump target") },
      { type: "item.created", item: agentMessage("after", "A newer message") },
    ],
    20,
  );
  const target = events.find(
    (event) => event.payload.type === "item.created" && event.payload.item.id === "target",
  );
  if (!target) throw new Error("Missing target");
  const result = window(f.store, f.thread, { aroundSeq: target.seq }, 1, 1);
  expect(result.items.some((item) => item.id === "target")).toBe(true);
  expect(result.items.some((item) => item.id === "oversized-before")).toBe(false);
  expect(result.targetSeq).toBe(target.seq);
  expect(result.itemsBefore).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024 * 1024);
});

// Mutations: leaking another device's cursor, regressing a cursor, accepting a forged device
// owner from payload or failing to cap at host head. Not executed (tests run at merge).
test("wire read marks belong to the authenticated device and persisted cursors only advance", async () => {
  const f = await socketFixture();
  cleanups.push(() => f.close());
  const first = await f.open();
  const second = await f.open();
  first.send({ type: "hello", protocolVersion: 1, deviceId: device, token: "a".repeat(64) });
  second.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("second-device"),
    token: "a".repeat(64),
  });
  await first.next();
  await second.next();
  const head = f.store.headSeq();
  first.send({
    type: "command",
    command: {
      id: CommandId.parse("read-high"),
      deviceId: device,
      payload: { type: "thread.markRead", threadId: f.thread.id, lastSeenSeq: head + 100 },
    },
  });
  expect(await first.next()).toMatchObject({
    type: "commandResult",
    commandId: "read-high",
    ok: true,
  });
  first.send({
    type: "command",
    command: {
      id: CommandId.parse("read-low"),
      deviceId: device,
      payload: { type: "thread.markRead", threadId: f.thread.id, lastSeenSeq: 0 },
    },
  });
  expect(await first.next()).toMatchObject({ type: "commandResult", ok: true });
  first.send({ type: "thread.readState", requestId: "state-first", threadId: f.thread.id });
  second.send({ type: "thread.readState", requestId: "state-second", threadId: f.thread.id });
  expect(await first.next()).toMatchObject({
    type: "thread.readState",
    requestId: "state-first",
    lastSeenSeq: head,
  });
  expect(await second.next()).toMatchObject({
    type: "thread.readState",
    requestId: "state-second",
    lastSeenSeq: 0,
  });
  first.send({
    type: "command",
    command: {
      id: CommandId.parse("forged-device"),
      deviceId: DeviceId.parse("second-device"),
      payload: { type: "thread.markRead", threadId: f.thread.id, lastSeenSeq: head },
    },
  });
  expect(await first.next()).toMatchObject({ type: "error" });
  expect(f.store.threadReadState(f.thread.id, DeviceId.parse("second-device")).lastSeenSeq).toBe(0);
});

// Mutations: forgetting descendant authorization, reading tombstoned threads through a new
// endpoint or treating operate/admin as read. Not executed (tests run at merge).
test("all long-thread reads enforce tombstones, child authorization and read scope", async () => {
  const deniedId = ThreadId.parse("denied-child");
  const f = await socketFixture({ canReadThread: (_device, id) => id !== deniedId });
  cleanups.push(() => f.close());
  const child = { ...f.thread, id: deniedId };
  f.store.appendEvents(child.id, [{ type: "thread.created", thread: child }]);
  f.store.appendEvents(f.thread.id, [
    {
      type: "agent.created",
      agent: Agent.parse({
        id: "child-summary",
        threadId: f.thread.id,
        childThreadId: child.id,
        parentId: null,
        origin: "ace",
        fidelity: "summary",
        native: { provider: "codex" },
        cwd: "/repo",
        status: { state: "idle" },
        createdAt: 1,
      }),
    },
  ]);
  const client = await f.connect();
  await client.next();
  client.send(
    ThreadSearchRequest.parse({
      type: "thread.search",
      requestId: "denied-tree",
      threadId: f.thread.id,
      text: "anything",
      scope: "tree",
    }),
  );
  expect(await client.next()).toMatchObject({
    type: "error",
    code: "forbidden",
    requestId: "denied-tree",
  });
  f.store.deleteThread(f.thread.id);
  for (const request of [
    TurnsPageRequest.parse({ type: "turns.page", requestId: "dead-turns", threadId: f.thread.id }),
    ItemsWindowRequest.parse({
      type: "items.window",
      requestId: "dead-window",
      threadId: f.thread.id,
      aroundSeq: 0,
    }),
    ThreadSearchRequest.parse({
      type: "thread.search",
      requestId: "dead-search",
      threadId: f.thread.id,
      text: "anything",
    }),
    ThreadCatchUpRequest.parse({
      type: "thread.catchUp",
      requestId: "dead-catch-up",
      threadId: f.thread.id,
      sinceSeq: 0,
    }),
    ThreadReadStateRequest.parse({
      type: "thread.readState",
      requestId: "dead-read-state",
      threadId: f.thread.id,
    }),
  ]) {
    client.send(request);
    expect(await client.next()).toMatchObject({ type: "error", requestId: request.requestId });
  }
  const remote = await remoteFixture();
  const paired = await remote.pair(["operate"]);
  const ticket = await remote.ticket(paired.token);
  const noRead = await remote.connectTicket(paired.device.id, ticket.ticket);
  await noRead.next();
  noRead.send(
    TurnsPageRequest.parse({
      type: "turns.page",
      requestId: "no-read-scope",
      threadId: remote.thread.id,
    }),
  );
  expect(await noRead.next()).toMatchObject({
    type: "error",
    code: "forbidden",
    requestId: "no-read-scope",
  });
});

// Mutations: rewriting redundant read marks, losing read state during daemon restart or
// sharing device cursors. Not executed (tests run at merge).
test("daemon restart preserves independent device read cursors and redundant writes preserve update time", async () => {
  const f = storeFixture();
  const second = DeviceId.parse("second-device");
  const head = f.store.headSeq();
  f.store.markThreadRead(f.thread.id, device, head);
  f.store.markThreadRead(f.thread.id, second, head - 1);
  const firstState = f.store.threadReadState(f.thread.id, device);
  f.store.markThreadRead(f.thread.id, device, head);
  f.store.markThreadRead(f.thread.id, device, 0);
  expect(f.store.threadReadState(f.thread.id, device)).toEqual(firstState);
  await f.restart();
  expect(f.store.threadReadState(f.thread.id, device)).toEqual(firstState);
  expect(f.store.threadReadState(f.thread.id, second).lastSeenSeq).toBe(head - 1);
});
