import { expect, test } from "vitest";
import { createTranslator } from "./index.ts";
import { harness } from "./translator.test-helper.ts";

const register = (h: ReturnType<typeof harness>) =>
  h.system("task_started", { task_id: "C", tool_use_id: "launch", task_type: "local_agent" });
const complete = (h: ReturnType<typeof harness>) =>
  h.system("task_updated", { task_id: "C", patch: { status: "completed" } });
const permission = (h: ReturnType<typeof harness>) =>
  h.send(
    {
      toolName: "Read",
      input: { file_path: "file" },
      options: { requestId: "approval", toolUseID: "read", agentID: "C" },
    },
    "can_use_tool",
  );

for (const timing of ["before", "after"])
  test(`a permission received ${timing} completion cannot leave a settled child's tool live`, () => {
    const h = harness();
    h.init();
    register(h);
    if (timing === "before") permission(h);
    complete(h);
    if (timing === "after") permission(h);
    h.send({ requestId: "approval", result: { behavior: "allow" } }, "can_use_tool", "send");
    h.result();
    expect(h.state.status.state).toBe("done");
    expect(
      h.items().find((item) => item.type === "tool_call" && item.call.kind === "file.read"),
    ).toMatchObject({ complete: true, call: { status: "cancelled" } });
    expect(Object.values(h.state.interactions).map((interaction) => interaction.state)).toEqual(
      timing === "before" ? ["cancelled"] : [],
    );
  });

for (const uuid of [true, false])
  test(`late paragraph replay preserves settled child paragraphs ${uuid ? "with" : "without"} UUIDs`, () => {
    const h = harness();
    h.init();
    register(h);
    const paragraph = (text: string, id = "m") =>
      h.send({
        type: "assistant",
        parent_tool_use_id: "launch",
        ...(uuid ? { uuid: `${id}:${text}` } : {}),
        message: { id, content: [{ type: "text", text }] },
      });
    paragraph("one");
    paragraph("two");
    paragraph("other", "another-message");
    complete(h);
    h.result();
    paragraph("two");
    paragraph("one");
    paragraph("other", "another-message");
    expect(
      h
        .items()
        .filter((item) => item.type === "message")
        .flatMap((item) => item.parts),
    ).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
      { type: "text", text: "other" },
    ]);
    expect(Object.values(h.state.runs)).toHaveLength(2);
    expect(h.state.status.state).toBe("done");
  });

for (const status of ["completed", "failed", "killed", "stopped"])
  test(`known ${status} child registration emits no live turn`, () => {
    const translator = createTranslator({ rootKey: "root" });
    translator.translate(
      {
        seq: 0,
        t: 0,
        dir: "recv",
        channel: "sdk",
        data: { type: "system", subtype: "init", session_id: "s" },
      },
      0,
    );
    translator.translate(
      {
        seq: 1,
        t: 1,
        dir: "recv",
        channel: "sdk",
        data: { type: "system", subtype: "task_updated", task_id: "C", patch: { status } },
      },
      1,
    );
    const facts = translator.translate(
      {
        seq: 2,
        t: 2,
        dir: "recv",
        channel: "sdk",
        data: {
          type: "system",
          subtype: "task_started",
          task_id: "C",
          tool_use_id: "launch",
          task_type: "local_agent",
        },
      },
      2,
    );
    const child = facts.find((fact) => fact.type === "agent.seen" && fact.native?.nativeId === "C");
    expect(child).toBeDefined();
    expect(facts.some((fact) => fact.type === "turn.ended" && fact.agent !== "root")).toBe(true);
    expect(facts.filter((fact) => fact.type === "turn.started")).toEqual([]);
  });

test("new missing deadline survives cancellation, previous expiry and another removal", () => {
  const h = harness();
  h.init();
  const level = (ids: string[], now: number) =>
    h.send(
      {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: ids.map((task_id) => ({ task_id, task_type: "local_bash", ambient: true })),
      },
      "sdk",
      "recv",
      now,
    );
  level(["one", "two"], 10);
  level([], 100);
  expect(h.deadline()).toBe(1100);
  level(["one"], 200);
  h.tick(1100);
  expect(Object.values(h.state.tasks).map((task) => task.status)).toEqual(["running", "unknown"]);
  level([], 1200);
  expect(h.deadline()).toBe(2200);
  h.tick(2200);
  expect(Object.values(h.state.tasks).map((task) => task.status)).toEqual(["unknown", "unknown"]);
});

test("late approval preserves a settled child's successful tool result", () => {
  const h = harness();
  h.init();
  register(h);
  permission(h);
  h.send({
    type: "user",
    parent_tool_use_id: "launch",
    message: { content: [{ type: "tool_result", tool_use_id: "read", content: "file" }] },
  });
  complete(h);
  h.send({ requestId: "approval", result: { behavior: "allow" } }, "can_use_tool", "send");
  h.result();
  expect(
    h.items().find((item) => item.type === "tool_call" && item.call.kind === "file.read"),
  ).toMatchObject({ complete: true, call: { status: "succeeded" } });
  expect(h.state.status.state).toBe("done");
});

test("late complete blocks keep the identities of a settled child's streamed paragraphs", () => {
  const h = harness();
  h.init();
  register(h);
  const streamEvent = (event: unknown) =>
    h.send({ type: "stream_event", parent_tool_use_id: "launch", event });
  const paragraph = (uuid: string, text: string) =>
    h.send({
      type: "assistant",
      parent_tool_use_id: "launch",
      uuid,
      message: { id: "streamed", content: [{ type: "text", text }] },
    });
  streamEvent({ type: "message_start", message: { id: "streamed" } });
  streamEvent({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "one" },
  });
  paragraph("one", "one");
  streamEvent({
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "two" },
  });
  paragraph("two", "two");
  complete(h);
  h.result();
  paragraph("two", "two");
  paragraph("one", "one");
  expect(
    h
      .items()
      .filter((item) => item.type === "message")
      .flatMap((item) => item.parts),
  ).toEqual([
    { type: "text", text: "one" },
    { type: "text", text: "two" },
  ]);
  expect(h.state.status.state).toBe("done");
});

test("a permission after a known terminal edge cannot start a child before registration", () => {
  const translator = createTranslator({ rootKey: "root" });
  translator.translate(
    {
      seq: 0,
      t: 0,
      dir: "recv",
      channel: "sdk",
      data: { type: "system", subtype: "init", session_id: "s" },
    },
    0,
  );
  translator.translate(
    {
      seq: 1,
      t: 1,
      dir: "recv",
      channel: "sdk",
      data: {
        type: "system",
        subtype: "task_updated",
        task_id: "C",
        patch: { status: "completed" },
      },
    },
    1,
  );
  const facts = translator.translate(
    {
      seq: 2,
      t: 2,
      dir: "recv",
      channel: "can_use_tool",
      data: {
        toolName: "Read",
        input: { file_path: "file" },
        options: { requestId: "approval", toolUseID: "read", agentID: "C" },
      },
    },
    2,
  );
  expect(facts.some((fact) => fact.type === "agent.seen" && fact.native?.nativeId === "C")).toBe(
    true,
  );
  expect(facts.filter((fact) => fact.type === "turn.started")).toEqual([]);
  expect(facts.filter((fact) => fact.type === "interaction.opened")).toEqual([]);
  const h = harness();
  h.init();
  complete(h);
  permission(h);
  expect(
    h.items().find((item) => item.type === "tool_call" && item.call.kind === "file.read"),
  ).toMatchObject({ complete: true, call: { status: "cancelled" } });
  h.send({ requestId: "approval", result: { behavior: "allow" } }, "can_use_tool", "send");
  register(h);
  h.result();
  expect(h.state.status.state).toBe("done");
  expect(
    h.items().find((item) => item.type === "tool_call" && item.call.kind === "file.read"),
  ).toMatchObject({ complete: true, call: { status: "cancelled" } });
});

test("late paragraph metadata preserves the original payload and the replay payload", () => {
  const h = harness();
  h.init();
  register(h);
  const paragraph = (marker: string) =>
    h.send({
      type: "assistant",
      parent_tool_use_id: "launch",
      uuid: "same-block",
      marker,
      message: { id: "m", content: [{ type: "text", text: "paragraph" }] },
    });
  paragraph("original-metadata");
  complete(h);
  h.result();
  paragraph("replay-metadata");
  const payloads = h
    .items()
    .flatMap((item) =>
      item.type === "tool_call"
        ? (item.call.raw ?? [])
        : item.type === "compaction"
          ? []
          : (item.raw ?? []),
    );
  for (const marker of ["original-metadata", "replay-metadata"])
    expect(
      payloads.filter(
        (payload) => "data" in payload && JSON.stringify(payload.data)?.includes(marker),
      ),
    ).toHaveLength(1);
  expect(h.items().filter((item) => item.type === "message")).toHaveLength(1);
});
