import { expect, it } from "vitest";
import { createOpenCodeAdapter, discoverOpenCodeModels } from "./index.ts";
import { spawnSupervised } from "@ace/provider-kit/process";
import { ThreadId } from "@ace/protocol";
import { setup, deferred } from "./testing/v2-session.ts";
import { array, object } from "./data.ts";
import type { Frame } from "@ace/engine-api";

it("metadata discovery retains variants and limits while excluding secrets and closing its own server", async () => {
  const h = await setup();
  const exited = deferred<void>();
  const metadata = await discoverOpenCodeModels(
    {
      ...h.options,
      runtime: {
        ...h.options.runtime,
        spawn: (options) => {
          const proc = spawnSupervised(options);
          void proc.exited.then(() => exited.resolve());
          return proc;
        },
      },
    },
    "/one",
    new AbortController().signal,
  );
  expect(object(metadata).location).toEqual({ directory: "/one" });
  expect(array(object(metadata).data)[0]).toMatchObject({
    variants: [{ id: "high" }],
    limit: { context: 200000, output: 8192 },
  });
  expect(JSON.stringify(metadata)).not.toContain("secret");
  expect(JSON.stringify(metadata)).not.toContain("authorization");
  await exited.promise;
});

it("an account environment preserves admission correlation and refused idle closure leaves its process alive", async () => {
  const h = await setup();
  const frames: Frame[] = [];
  const session = await h.adapter.openSession({
    cwd: "/account",
    threadId: ThreadId.parse("thread_account"),
    env: { ACE_TEST_INSTANCE: "selected-account" },
    instanceId: "selected-account",
    signal: new AbortController().signal,
    onFrame: (frame) => frames.push(frame),
    onExit: () => {},
  });
  expect(session.instanceId).toBe("selected-account");
  expect(await h.control("/test/instance")).toEqual({ instance: "selected-account" });
  await session.send([{ type: "text", text: "account input" }], "queue", "account-command");
  await expect(session.close("idle")).rejects.toThrow("unsettled");
  expect(await h.control("/test/instance")).toEqual({ instance: "selected-account" });
  const translator = h.adapter.createTranslator({
    threadId: ThreadId.parse("thread_account"),
    rootKey: "root",
  });
  expect(
    frames
      .flatMap((frame) => translator.translate(frame, frame.t))
      .filter((fact) => fact.type === "input.admitted")
      .map((fact) => fact.commandId),
  ).toEqual(["account-command"]);
  await session.close("user");
  await h.session.send([{ type: "text", text: "default instance survives" }], "queue");
  expect(await h.control("/test/instance")).toEqual({ instance: "default" });
});

it("cancelling startup closes the stdin lease and stops only the owned process", async () => {
  const h = await setup();
  const entered = deferred<void>(),
    exited = deferred<void>();
  const controller = new AbortController();
  const adapter = createOpenCodeAdapter({
    ...h.options,
    runtime: {
      ...h.options.runtime,
      spawn: (options) => {
        const proc = spawnSupervised(options);
        void proc.exited.then(() => exited.resolve());
        return proc;
      },
      fetch: async (_input, init) => {
        entered.resolve();
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new Error("cancelled"));
          init?.signal?.addEventListener("abort", abort, { once: true });
          if (init?.signal?.aborted) abort();
        });
      },
    },
  });
  try {
    const opening = adapter.openSession({
      cwd: "/one",
      threadId: ThreadId.parse("thread_cancel"),
      signal: controller.signal,
      onFrame: () => {},
      onExit: () => {},
    });
    const rejected = expect(opening).rejects.toThrow();
    await entered.promise;
    controller.abort();
    await rejected;
    await exited.promise;
  } finally {
    await adapter.close();
  }
});

it("closing an adapter stops its isolated account process without stopping another adapter", async () => {
  const h = await setup();
  const exited = deferred<void>();
  const adapter = createOpenCodeAdapter({
    ...h.options,
    runtime: {
      ...h.options.runtime,
      spawn: (options) => {
        const proc = spawnSupervised(options);
        void proc.exited.then(() => exited.resolve());
        return proc;
      },
    },
  });
  try {
    await adapter.openSession({
      cwd: "/account",
      threadId: ThreadId.parse("thread_account_close"),
      env: { ACE_TEST_INSTANCE: "owned-account" },
      signal: new AbortController().signal,
      onFrame: () => {},
      onExit: () => {},
    });
    await adapter.close();
    await exited.promise;
    await h.session.send([{ type: "text", text: "other adapter survives" }], "queue");
    expect(await h.control("/test/instance")).toEqual({ instance: "default" });
  } finally {
    await adapter.close();
  }
});

it("explicit attachment never spawns or stops the external server, including on transport loss", async () => {
  const h = await setup();
  const frames: unknown[] = [];
  const recovered = deferred<void>();
  const adapter = createOpenCodeAdapter({
    attach: h.transport(),
    runtime: {
      spawn: () => {
        throw new Error("External ownership violated");
      },
    },
  });
  try {
    const session = await adapter.openSession({
      cwd: "/one",
      threadId: ThreadId.parse("thread_attach"),
      signal: new AbortController().signal,
      onExit: () => {},
      onFrame: (frame) => {
        frames.push(frame);
        if (frame.channel === "lifecycle" && object(frame.data).type === "resynced")
          recovered.resolve();
      },
    });
    await h.control("/test/drop", {});
    await recovered.promise;
    await session.close("user");
    await adapter.close();
    expect(await h.control("/test/connections")).toBeGreaterThan(1);
    expect(JSON.stringify(frames)).not.toContain(h.transport().authorization);
  } finally {
    await adapter.close();
  }
});

it("a child event proves its ancestor chain before entering the thread and foreign roots stay excluded", async () => {
  const h = await setup(),
    root = h.session.nativeSessionId;
  await h.control("/test/state", {
    sessions: [
      {
        id: "missed-child",
        parentID: root,
        projectID: "project-one",
        location: { directory: "/one" },
      },
      { id: "unrelated", projectID: "project-one", location: { directory: "/one" } },
    ],
  });
  await h.publish("permission.asked", {
    sessionID: "missed-child",
    id: "ask",
    action: "edit",
    resources: ["x"],
  });
  expect(Object.values(h.projection.view.agents).map((a) => a.native.nativeId)).toContain(
    "missed-child",
  );
  expect(h.projection.view.thread.status.state).toBe("needs_you");
  await h.control("/test/events", [
    {
      type: "permission.asked",
      directory: "/one",
      data: { sessionID: "unrelated", id: "foreign", action: "edit", resources: ["x"] },
    },
  ]);
  await h.publish("session.execution.started");
  expect(Object.values(h.projection.view.agents).map((a) => a.native.nativeId)).not.toContain(
    "unrelated",
  );
  expect(Object.values(h.projection.view.interactions)).toHaveLength(1);
});

it("a verified location move changes routing and file admission while old-directory work is excluded", async () => {
  const h = await setup(),
    root = h.session.nativeSessionId;
  await h.control("/test/state", {
    sessions: [
      {
        id: root,
        projectID: "project-two",
        location: { directory: "/new" },
        time: { updated: 2, idle: 2 },
      },
    ],
  });
  const from = h.frames.length;
  await h.publish("session.moved", { location: { directory: "/new" } });
  await h.seen(
    (f) =>
      f.channel === "snapshot.info" &&
      object(object(object(f.data).info).location).directory === "/new",
    from,
  );
  await h.session.send([{ type: "file", path: "image.png" }], "queue");
  const prompt = array(await h.control("/test/requests"))
    .map(object)
    .find((r) => String(r.path).endsWith("/prompt"));
  expect(object(prompt?.body).files).toEqual([{ uri: "file:///new/image.png" }]);
  await h.control("/test/events", [
    {
      type: "session.text.started",
      directory: "/one",
      data: { sessionID: root, assistantMessageID: "foreign", ordinal: 0 },
    },
  ]);
  await h.publish("session.execution.started", {}, "/new");
  expect(
    Object.values(h.projection.view.items).some((item) => JSON.stringify(item).includes("foreign")),
  ).toBe(false);
});

it("concurrent steer and queue wait for HTTP admission without rejecting or duplicating inputs", async () => {
  const h = await setup();
  await h.control("/test/state", { fault: { holdPrompt: true } });
  const from = h.frames.length;
  const first = h.session.send([{ type: "text", text: "first" }], "queue", "command-first");
  await h.seen(
    (f) => f.channel === "sse" && object(f.data).type === "session.inbox.enqueued",
    from,
  );
  const second = h.session.send([{ type: "text", text: "second" }], "steer", "command-second");
  expect(
    array(await h.control("/test/requests"))
      .map(object)
      .filter((r) => String(r.path).endsWith("/prompt"))
      .map((r) => object(r.body).text),
  ).toEqual(["first"]);
  await h.control("/test/release-prompt", {});
  await Promise.all([first, second]);
  expect(
    array(await h.control("/test/requests"))
      .map(object)
      .filter((r) => String(r.path).endsWith("/prompt"))
      .map((r) => object(r.body).text),
  ).toEqual(["first", "second"]);
  const translator = h.adapter.createTranslator({
    threadId: ThreadId.parse("thread_v2"),
    rootKey: "root",
  });
  const admitted = h.frames
    .flatMap((frame) => translator.translate(frame, frame.t))
    .filter((fact) => fact.type === "input.admitted");
  expect(admitted.map((fact) => fact.commandId)).toEqual(["command-first", "command-second"]);
});
