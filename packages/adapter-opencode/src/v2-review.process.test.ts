import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { createOpenCodeAdapter } from "./index.ts";
import { setup, deferred } from "./testing/v2-session.ts";
import { object, array } from "./data.ts";
import { harness } from "./replay.ts";

it("an invisible admission receipt remains unsettled after completed work and two empty recovery snapshots", async () => {
  const h = await setup();
  await h.publish("session.execution.started");
  await h.publish("session.execution.succeeded");
  await h.control("/test/state", { fault: { promptInvisible: true } });
  const from = h.frames.length;
  await expect(h.session.send([{ type: "text", text: "uncertain" }], "queue")).rejects.toThrow(
    "uncertain",
  );
  await h.recovered(from);
  expect(h.projection.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
  const input = h.frames.find((f) => f.channel === "input.uncertain");
  await h.publish("session.inbox.cancelled", { inboxID: object(input?.data).id });
  expect(h.projection.view.thread.status.state).toBe("done");
  expect(
    array(await h.control("/test/requests"))
      .map(object)
      .filter((r) => String(r.path).endsWith("/prompt")),
  ).toHaveLength(1);
});

it("running snapshots and uncovered text suffixes survive deltas arriving after the last history read", async () => {
  const activeRead = deferred<void>(),
    release = deferred<void>();
  let reads = 0;
  const h = await setup({
    runtime: {
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/api/session/active" && ++reads === 2) {
          activeRead.resolve();
          await release.promise;
        }
        return response;
      },
    },
  });
  const root = h.session.nativeSessionId;
  await h.publish("session.execution.started");
  await h.publish("session.execution.succeeded");
  await h.control("/test/state", {
    active: { [root]: { type: "running" } },
    messages: {
      [root]: [{ id: "a", type: "assistant", content: [{ type: "text", text: "prefix" }] }],
    },
  });
  const from = h.frames.length;
  await h.control("/test/drop", {});
  await activeRead.promise;
  await h.control("/test/events", [
    {
      type: "session.text.delta",
      data: { sessionID: root, assistantMessageID: "a", ordinal: 0, delta: " suffix" },
    },
  ]);
  await h.seen(
    (f) => f.channel === "recovery.buffered" && object(f.data).type === "session.text.delta",
    from,
  );
  release.resolve();
  await h.recovered(from);
  const text = Object.values(h.projection.view.items).find(
    (i) => i.type === "message" && i.role === "assistant",
  );
  expect(text?.type === "message" && text.parts).toEqual([{ type: "text", text: "prefix suffix" }]);
  expect(h.projection.view.thread.status.state).toBe("working");
  await h.publish("session.execution.succeeded");
  expect(h.projection.view.thread.status.state).toBe("done");
});

it("covered deltas reconcile once while a later ordinal is still replayed", async () => {
  const activeRead = deferred<void>(),
    release = deferred<void>();
  let reads = 0;
  const h = await setup({
      runtime: {
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (
            new URL(input instanceof Request ? input.url : String(input)).pathname ===
              "/api/session/active" &&
            ++reads === 2
          ) {
            activeRead.resolve();
            await release.promise;
          }
          return response;
        },
      },
    }),
    root = h.session.nativeSessionId;
  await h.control("/test/state", {
    fault: { holdHistory: true },
    beforeRead: [
      {
        type: "session.text.delta",
        data: { sessionID: root, assistantMessageID: "a", ordinal: 0, delta: "covered" },
      },
    ],
    messages: {
      [root]: [{ id: "a", type: "assistant", content: [{ type: "text", text: "covered" }] }],
    },
  });
  const from = h.frames.length;
  await h.control("/test/drop", {});
  await h.seen(
    (f) => f.channel === "recovery.buffered" && object(f.data).type === "session.text.delta",
    from,
  );
  await h.control("/test/release", {});
  await activeRead.promise;
  const suffixFrom = h.frames.length;
  await h.control("/test/events", [
    {
      type: "session.text.delta",
      data: { sessionID: root, assistantMessageID: "a", ordinal: 1, delta: "next ordinal" },
    },
  ]);
  await h.seen(
    (f) => f.channel === "recovery.buffered" && object(f.data).type === "session.text.delta",
    suffixFrom,
  );
  release.resolve();
  await h.recovered(from);
  const texts = Object.values(h.projection.view.items).flatMap((i) =>
    i.type === "message" && i.role === "assistant" ? [i.parts] : [],
  );
  expect(texts).toEqual([
    [{ type: "text", text: "covered" }],
    [{ type: "text", text: "next ordinal" }],
  ]);
});

it("source-shaped background child dispatches each await their own synthetic completion", async () => {
  const h = await setup(),
    root = h.session.nativeSessionId;
  await h.publish("session.created", {
    sessionID: "child",
    parentID: root,
    projectID: "project-one",
    location: { directory: "/one" },
  });
  const dispatch = async (toolID: string) => {
    await h.publish("session.execution.started");
    await h.publish("session.tool.called", {
      assistantMessageID: "a",
      id: toolID,
      name: "subagent",
      input: { background: true },
    });
    await h.publish("session.tool.success", {
      assistantMessageID: "a",
      id: toolID,
      metadata: { sessionID: "child", status: "running" },
    });
    await h.publish("session.execution.started", { sessionID: "child" });
    await h.publish("session.execution.succeeded");
    await h.publish("session.execution.succeeded", { sessionID: "child" });
    expect(h.projection.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
  };
  const complete = async () => {
    await h.publish("session.synthetic", {
      metadata: { source: "subagent", childID: "child", state: "completed" },
    });
    await h.publish("session.execution.started");
    await h.publish("session.execution.succeeded");
    expect(h.projection.view.thread.status.state).toBe("done");
  };
  await dispatch("first");
  await complete();
  await dispatch("continuation");
  await complete();
});

it("location shutdown with empty data expires its interactions and forbids actions without settling work", async () => {
  const h = await setup();
  await h.publish("session.execution.started");
  await h.publish("permission.asked", { id: "ask", action: "edit", resources: ["x"] });
  await h.publish("form.created", {
    form: {
      id: "lost-form",
      sessionID: h.session.nativeSessionId,
      title: "Question",
      metadata: { kind: "question" },
      fields: [{ key: "q0", type: "string" }],
    },
  });
  const pending = Object.values(h.projection.view.interactions)[0];
  const from = h.frames.length;
  await h.control("/test/events", [{ type: "location.shutdown", directory: "/one", data: {} }]);
  await h.seen((f) => f.channel === "sse" && object(f.data).type === "location.shutdown", from);
  expect(Object.values(h.projection.view.interactions).map((i) => i.state)).toEqual([
    "expired",
    "expired",
  ]);
  expect(h.projection.view.thread.status.state).not.toBe("done");
  await expect(h.session.send([{ type: "text", text: "after loss" }], "queue")).rejects.toThrow(
    "location",
  );
  if (!pending) throw new Error("Expected interaction");
  await expect(
    h.session.resolve(`permission:${h.session.nativeSessionId}:ask`, {
      kind: "approval",
      optionId: "once",
    }),
  ).rejects.toThrow();
});

it("foreign location shutdown does not expire an owned interaction", async () => {
  const h = await setup();
  await h.publish("permission.asked", { id: "ask", action: "edit", resources: ["x"] });
  await h.control("/test/events", [{ type: "location.shutdown", directory: "/foreign", data: {} }]);
  await h.publish("session.execution.started");
  expect(Object.values(h.projection.view.interactions)[0]?.state).toBe("pending");
});

it("closing an external attachment closes its sessions and recovery waiters while leaving the server reachable", async () => {
  const owner = await setup(),
    projection = harness(),
    exits: unknown[] = [];
  const disconnected = deferred<void>(),
    history = deferred<void>(),
    interaction = deferred<void>();
  let externalID = "";
  const adapter = createOpenCodeAdapter({
    ...owner.options,
    attach: owner.transport(),
    runtime: {
      ...owner.options.runtime,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (externalID && url.pathname === `/api/session/${externalID}/message`) {
          history.resolve();
          const signal = init?.signal;
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(new Error("Cancelled fake history read"));
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        }
        return fetch(input, init);
      },
    },
  });
  const session = await adapter.openSession({
    threadId: ThreadId.parse("thread_external"),
    rootKey: "root",
    cwd: "/one",
    signal: new AbortController().signal,
    onFrame: (f) => {
      projection.feed(f);
      if (f.channel === "sse" && object(f.data).type === "permission.asked") interaction.resolve();
      if (f.channel === "lifecycle" && object(f.data).type === "disconnected")
        disconnected.resolve();
      if (f.dir === "send" && String(object(f.data).path).endsWith("/message")) history.resolve();
    },
    onExit: (e) => exits.push(e),
  });
  externalID = session.nativeSessionId;
  try {
    await owner.control("/test/events", [
      {
        type: "permission.asked",
        data: { sessionID: session.nativeSessionId, id: "ask", action: "edit", resources: ["x"] },
      },
    ]);
    await interaction.promise;
    await owner.control("/test/drop", {});
    await disconnected.promise;
    await history.promise;
    const pendingSend = session.send([{ type: "text", text: "behind recovery" }], "queue");
    const rejection = expect(pendingSend).rejects.toThrow();
    await adapter.close();
    await rejection;
    expect(exits).toHaveLength(1);
    expect(Object.values(projection.view.interactions)[0]?.state).toBe("expired");
    await expect(session.send([{ type: "text", text: "closed" }], "queue")).rejects.toThrow();
    expect(object(await owner.control("/api/info")).version).toBe("2.0.22");
  } finally {
    await adapter.close();
  }
});

it("a delayed snapshot covers earlier chunks without duplicating them over a newer buffered suffix", async () => {
  const responseArrived = deferred<void>(),
    releaseResponse = deferred<void>();
  let historyReads = 0;
  const h = await setup({
      runtime: {
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (
            new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith(
              "/message",
            ) &&
            ++historyReads === 1
          ) {
            responseArrived.resolve();
            await releaseResponse.promise;
          }
          return response;
        },
      },
    }),
    root = h.session.nativeSessionId;
  await h.control("/test/state", {
    fault: { holdHistory: true },
    active: { [root]: { type: "running" } },
    beforeRead: [
      {
        type: "session.text.delta",
        data: { sessionID: root, assistantMessageID: "a", ordinal: 0, delta: "prefix" },
      },
    ],
    messages: {
      [root]: [{ id: "a", type: "assistant", content: [{ type: "text", text: "prefix" }] }],
    },
  });
  const from = h.frames.length;
  await h.control("/test/drop", {});
  await h.seen(
    (f) => f.channel === "recovery.buffered" && object(f.data).type === "session.text.delta",
    from,
  );
  await h.control("/test/release", {});
  await responseArrived.promise;
  const after = h.frames.length;
  await h.control("/test/events", [
    {
      type: "session.text.delta",
      data: { sessionID: root, assistantMessageID: "a", ordinal: 0, delta: " suffix" },
    },
  ]);
  await h.seen(
    (f) => f.channel === "recovery.buffered" && object(f.data).type === "session.text.delta",
    after,
  );
  releaseResponse.resolve();
  await h.recovered(from);
  const item = Object.values(h.projection.view.items).find((i) => i.type === "message");
  expect(item?.type === "message" && item.parts).toEqual([{ type: "text", text: "prefix suffix" }]);
  expect(h.projection.view.thread.status.state).toBe("working");
});

it("partial delta coverage fails recovery without falsely settling an active execution", async () => {
  const h = await setup(),
    root = h.session.nativeSessionId;
  await h.publish("session.execution.started");
  await h.control("/test/state", {
    fault: { holdHistory: true },
    beforeRead: [
      {
        type: "session.text.delta",
        data: { sessionID: root, assistantMessageID: "a", ordinal: 0, delta: "complete-chunk" },
      },
    ],
    messages: {
      [root]: [{ id: "a", type: "assistant", content: [{ type: "text", text: "complete" }] }],
    },
  });
  const from = h.frames.length;
  await h.control("/test/drop", {});
  await h.seen(
    (f) => f.channel === "recovery.buffered" && object(f.data).type === "session.text.delta",
    from,
  );
  const exited = h.seen((f) => f.channel === "lifecycle" && object(f.data).type === "exited", from);
  await h.control("/test/release", {});
  await exited;
  expect(h.projection.view.thread.status.state).not.toBe("done");
});
