import { expect, test } from "vitest";
import { harness, subtype } from "./session.test-helper.ts";
import { object } from "./native.ts";
import { apply, createThreadState } from "@ace/core";
import { createTranslator } from "./index.ts";
import { ThreadId } from "@ace/protocol";
test("multi-part ace input is correlated before its native SDK echo", async () => {
  const identities: { commandId: string; nativeId: string }[] = [];
  const h = await harness(
    undefined,
    "root",
    {},
    { onInputMessage: (identity) => identities.push(identity) },
  );
  try {
    await h.session.send(
      [
        { type: "text", text: "Handoff" },
        { type: "text", text: "Result" },
      ],
      "queue",
      "ace-wake",
      "ace",
    );
    const frame = await h.wait(
      (candidate) => candidate.dir === "send" && object(candidate.data)["type"] === "user",
    );
    expect(identities).toEqual([{ commandId: "ace-wake", nativeId: object(frame.data)["uuid"] }]);
    expect(object(frame.data)["isSynthetic"]).toBe(true);
    const translator = createTranslator({ rootKey: "root" });
    const facts = translator.translate(frame, frame.t);
    const echoes = facts.flatMap((fact) =>
      fact.type === "item.upsert" && fact.draft.type === "message" && fact.draft.role === "user"
        ? [fact.draft]
        : [],
    );
    expect(echoes).toEqual([
      expect.objectContaining({
        nativeId: identities[0]?.nativeId,
        parts: [
          { type: "text", text: "Handoff" },
          { type: "text", text: "Result" },
        ],
      }),
    ]);
  } finally {
    await h.session.close("user");
  }
});
test("the installed executable handshakes and receives queued input with a native session id", async () => {
  const h = await harness();
  try {
    await expect(h.session.send([{ type: "text", text: "hello" }], "steer")).rejects.toThrow(
      "steering",
    );
    await h.session.send([{ type: "text", text: "hello" }], "queue");
    const data = object(object((await h.wait(subtype("fake_input"))).data)["input"]);
    expect(data["session_id"]).toBe(h.session.nativeSessionId);
    expect(data["priority"]).toBe("next");
    expect(object(data["message"])["content"]).toEqual([{ type: "text", text: "hello" }]);
  } finally {
    await h.session.close("user");
  }
  expect(await h.exit).toMatchObject({ deliberate: true });
  await expect(h.session.send([], "queue")).rejects.toThrow("closed");
});
for (const scenario of ["approval", "question", "plan"] as const)
  test(`${scenario} replies reach the provider and reject duplicate answers`, async () => {
    const h = await harness();
    try {
      await h.session.send([{ type: "text", text: scenario }], "queue");
      const frame = await h.wait((f) => f.channel === "can_use_tool");
      const options = object(object(frame.data)["options"]);
      const id = String(options["requestId"]);
      await h.session.resolve(
        id,
        scenario === "question"
          ? { kind: "question", answers: { "Tabs?": ["Tabs"] } }
          : scenario === "plan"
            ? { kind: "plan_review", decision: "reject", feedback: "Revise it" }
            : { kind: "approval", optionId: "allow_updates" },
      );
      const response = object(
        object(object((await h.wait(subtype("fake_resolution"))).data)["response"])["response"],
      );
      if (scenario === "question")
        expect(object(response["updatedInput"])["answers"]).toEqual({ "Tabs?": "Tabs" });
      if (scenario === "plan")
        expect(response).toMatchObject({ behavior: "deny", message: "Revise it" });
      if (scenario === "approval")
        expect(response["updatedPermissions"]).toEqual([
          { type: "setMode", mode: "acceptEdits", destination: "session" },
        ]);
      await expect(h.session.resolve(id, { kind: "approval", optionId: "deny" })).rejects.toThrow(
        "no longer pending",
      );
    } finally {
      await h.session.close("user");
    }
  });
test("targeted stops and cascading interrupts reach live provider tasks", async () => {
  const h = await harness();
  try {
    await h.session.send([{ type: "text", text: "tasks" }], "queue");
    await h.wait((f) => object(f.data)["task_id"] === "shell-one");
    await h.session.stopTask(`claude:${h.session.nativeSessionId}:task:shell-one`);
    const request = object(
      object(
        (
          await h.wait(
            (f) =>
              subtype("fake_control")(f) &&
              object(object(f.data)["request"])["subtype"] === "stop_task",
          )
        ).data,
      )["request"],
    );
    expect(request["task_id"]).toBe("shell-one");
    await h.session.interrupt({ cascade: true });
    const stops = h.frames
      .filter((f) => subtype("fake_control")(f))
      .map((f) => object(object(f.data)["request"]))
      .filter((r) => r["subtype"] === "stop_task");
    expect(stops.some((r) => r["task_id"] === "child-one")).toBe(true);
  } finally {
    await h.session.close("user");
  }
});
test("unexpected provider exit is reported once and closes pending commands", async () => {
  const h = await harness();
  await h.session.send([{ type: "text", text: "crash" }], "queue");
  expect(await h.exit).toMatchObject({ deliberate: false });
  await expect(h.session.stopTask("task")).rejects.toThrow("closed");
  await h.session.close("shutdown");
  expect(h.exits).toHaveLength(1);
});
test("engine cancellation closes the supervised provider process", async () => {
  const h = await harness();
  h.controller.abort();
  expect(await h.exit).toMatchObject({ deliberate: true });
  await h.session.close("shutdown");
});
test("a provider cancellation withdraws the permission promise", async () => {
  const h = await harness();
  try {
    await h.session.send([{ type: "text", text: "cancel" }], "queue");
    const request = await h.wait((f) => f.channel === "can_use_tool");
    const id = String(object(object(request.data)["options"])["requestId"]);
    await h.wait((f) => object(f.data)["type"] === "control_cancel_request");
    await expect(
      h.session.resolve(id, { kind: "approval", optionId: "allow_once" }),
    ).rejects.toThrow("no longer pending");
  } finally {
    await h.session.close("user");
  }
});
test("SDK control requests and replies are forwarded in both directions", async () => {
  const h = await harness();
  try {
    expect(
      h.frames.some(
        (f) =>
          f.dir === "send" && f.channel === "wire" && object(f.data)["type"] === "control_request",
      ),
    ).toBe(true);
    expect(
      h.frames.some(
        (f) =>
          f.dir === "recv" && f.channel === "wire" && object(f.data)["type"] === "control_response",
      ),
    ).toBe(true);
  } finally {
    await h.session.close("user");
  }
});
test("malformed output and future messages reach the engine while the SDK continues", async () => {
  const h = await harness();
  try {
    await h.session.send([{ type: "text", text: "future" }], "queue");
    await h.wait((f) => object(f.data)["type"] === "result");
    expect(h.frames.map((f) => f.data)).toContainEqual({
      type: "malformed_stdout",
      line: "malformed JSON",
    });
    expect(h.frames.map((f) => f.data)).toContain(null);
    expect(h.frames.map((f) => f.data)).toContainEqual({
      type: "future_frame",
      novel: { value: 42 },
    });
  } finally {
    await h.session.close("user");
  }
});
test("resume initializes the requested native session before any input is sent", async () => {
  const id = "cdf0f865-7bc2-4f24-9d5d-9d83be2a9da9";
  const h = await harness(id);
  try {
    expect(h.session.nativeSessionId).toBe(id);
    const control = await h.wait(subtype("fake_control"));
    expect(object(control.data)["argv"]).toEqual(expect.arrayContaining([`--resume=${id}`]));
    expect(h.frames.some((f) => f.dir === "send" && object(f.data)["type"] === "user")).toBe(false);
  } finally {
    await h.session.close("shutdown");
  }
});
test("approving a plan returns permission and resets the CLI permission mode", async () => {
  const h = await harness();
  try {
    await h.session.send([{ type: "text", text: "plan" }], "queue");
    const permission = await h.wait((f) => f.channel === "can_use_tool");
    const id = String(object(object(permission.data)["options"])["requestId"]);
    await h.session.resolve(id, { kind: "plan_review", decision: "approve" });
    const response = object(
      object(object((await h.wait(subtype("fake_resolution"))).data)["response"])["response"],
    );
    expect(response["behavior"]).toBe("allow");
    const mode = await h.wait(
      (f) =>
        subtype("fake_control")(f) &&
        object(object(f.data)["request"])["subtype"] === "set_permission_mode",
    );
    expect(object(object(mode.data)["request"])["mode"]).toBe("default");
  } finally {
    await h.session.close("shutdown");
  }
});

test("an arbitrary engine root key targets the root interrupt", async () => {
  const h = await harness(undefined, "engine:root:42");
  try {
    await h.session.interrupt({ agent: "engine:root:42", cascade: false });
    expect(
      h.frames.some(
        (f) =>
          subtype("fake_control")(f) &&
          object(object(f.data)["request"])["subtype"] === "interrupt",
      ),
    ).toBe(true);
  } finally {
    await h.session.close("shutdown");
  }
});
test("a targeted cascade reaches a grandchild registered before its spawning tool", async () => {
  const h = await harness();
  try {
    await h.session.send([{ type: "text", text: "nested-tasks" }], "queue");
    await h.wait(subtype("nested-ready"));
    await h.session.interrupt({ agent: "child-one", cascade: true });
    const stops = h.frames
      .filter(subtype("fake_control"))
      .map((f) => object(object(f.data)["request"]))
      .filter((r) => r["subtype"] === "stop_task")
      .map((r) => r["task_id"]);
    expect(stops).toEqual(["child-one", "grandchild"]);
  } finally {
    await h.session.close("shutdown");
  }
});

test("SDK options deliver partial root text and forwarded child text", async () => {
  const h = await harness();
  try {
    await h.session.send([{ type: "text", text: "stream-probe" }], "queue");
    await h.wait((f) => object(f.data)["type"] === "result");
    const translator = createTranslator({ rootKey: "root" });
    const state = createThreadState({
      threadId: ThreadId.parse("probe"),
      config: { provider: "claude", silenceMs: 60_000 },
    });
    let id = 0;
    for (const f of h.frames)
      for (const fact of translator.translate(f, f.t))
        apply(state, fact, { now: f.t, ids: { next: (k) => `${k}:${++id}` } });
    const text = Object.values(state.items)
      .filter((i) => i.type === "message")
      .map((i) => i.parts);
    expect(text).toContainEqual([{ type: "text", text: "partial answer" }]);
    expect(text).toContainEqual([{ type: "text", text: "child answer" }]);
  } finally {
    await h.session.close("shutdown");
  }
});
test("selected question identities survive native comma serialization", async () => {
  const h = await harness();
  try {
    await h.session.send([{ type: "text", text: "question" }], "queue");
    const request = await h.wait((f) => f.channel === "can_use_tool");
    const id = String(object(object(request.data)["options"])["requestId"]);
    const resolution = { kind: "question" as const, answers: { "Tabs?": ["Tabs", "Spaces, two"] } };
    await h.session.resolve(id, resolution);
    const native = object(
      object(object((await h.wait(subtype("fake_resolution"))).data)["response"])["response"],
    );
    expect(object(native["updatedInput"])["answers"]).toEqual({ "Tabs?": ["Tabs", "Spaces, two"] });
    const translator = createTranslator({ rootKey: "root" });
    const state = createThreadState({
      threadId: ThreadId.parse("answers"),
      config: { provider: "claude", silenceMs: 60_000 },
    });
    let identity = 0;
    for (const f of h.frames)
      for (const fact of translator.translate(f, f.t))
        apply(state, fact, { now: f.t, ids: { next: (k) => `${k}:${++identity}` } });
    expect(Object.values(state.interactions)[0]?.resolution).toEqual(resolution);
  } finally {
    await h.session.close("shutdown");
  }
});

test("the Claude CLI receives image content with the original MIME and base64 bytes", async () => {
  const imageData = (
    await (
      await import("node:fs/promises")
    ).readFile(new URL("../../context/fixtures/colours.png", import.meta.url))
  ).toString("base64");

  const h = await harness();
  try {
    await h.session.send(
      [
        { type: "text", text: "hello" },
        { type: "image", mimeType: "image/png", url: `data:image/png;base64,${imageData}` },
      ],
      "queue",
    );
    const data = object(object((await h.wait(subtype("fake_input"))).data).input);
    expect(object(data.message).content).toEqual([
      { type: "text", text: "hello" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: imageData } },
    ]);
  } finally {
    await h.session.close("user");
  }
});
