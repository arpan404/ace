import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Frame } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createClaudeAdapter } from "./index.ts";
import { object } from "./native.ts";
let directory: string;
let executable: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ace-claude-test-"));
  executable = join(directory, "claude");
  const script = fileURLToPath(new URL("./testing/cli.ts", import.meta.url));
  await writeFile(executable, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  await chmod(executable, 0o755);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function harness(resume?: string) {
  const frames: Frame[] = [];
  const waiters: { predicate(frame: Frame): boolean; resolve(frame: Frame): void }[] = [];
  const exit = Promise.withResolvers<{ deliberate: boolean; message?: string }>();
  const controller = new AbortController();
  const adapter = createClaudeAdapter({ executable });
  const session = await adapter.openSession({
    threadId: ThreadId.parse("session-test"),
    cwd: directory,
    signal: controller.signal,
    onFrame(frame) {
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter?.predicate(frame)) {
          waiters.splice(i, 1);
          waiter.resolve(frame);
        }
      }
    },
    ...(resume ? { resume: { nativeSessionId: resume } } : {}),
    onExit: exit.resolve,
  });
  function wait(predicate: (frame: Frame) => boolean) {
    const prior = frames.find(predicate);
    if (prior) return Promise.resolve(prior);
    return new Promise<Frame>((resolve) => waiters.push({ predicate, resolve }));
  }
  return { session, wait, frames, exit: exit.promise, controller };
}
const subtype = (value: string) => (frame: Frame) => object(frame.data)["subtype"] === value;
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
            : { kind: "approval", optionId: "allow_session:0" },
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
