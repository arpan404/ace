import { expect, test } from "vitest";
import { apply, createThreadState, hasRunningForegroundCommand } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { harness, subtype } from "./session.test-helper.ts";
import { createTranslator } from "./index.ts";
import { object } from "./native.ts";

// Claude Code holds a `now` message until the running foreground tool returns. Backgrounding the
// tool (the `background_tasks` control, Ctrl+B) lets the steer in without stopping the command.

const steerText = (frame: Frame) =>
  JSON.stringify(object(object(frame.data)["input"])["message"]).includes("check the log");

/** The thread the recorded frames project to. */
function project(frames: Frame[]) {
  const state = createThreadState({
    threadId: ThreadId.parse("steer-backgrounding"),
    config: { provider: "claude", silenceMs: 60_000 },
  });
  const translator = createTranslator({ rootKey: "root" });
  let id = 0;
  const ids = { next: (kind: string) => `${kind}_${++id}` };
  for (const frame of frames)
    for (const fact of translator.translate(frame, frame.t)) apply(state, fact, { now: frame.t, ids });
  return state;
}

async function blockedOnCommand(env: Record<string, string> = {}) {
  const h = await harness(undefined, "root", { env });
  await h.session.send([{ type: "text", text: "foreground-wait" }], "queue");
  await h.wait(subtype("task_started"));
  await h.session.send([{ type: "text", text: "check the log" }], "steer");
  await h.wait((frame) => object(frame.data)["subtype"] === "fake_held" && steerText(frame));
  return h;
}

test("a steer held behind a foreground command reaches the model once the command moves to the background, and the command keeps running", async () => {
  const h = await blockedOnCommand();
  try {
    expect(h.frames.some((f) => subtype("fake_input")(f) && steerText(f))).toBe(false);
    expect(hasRunningForegroundCommand(project(h.frames))).toBe(true);

    await expect(h.session.backgroundTools?.()).resolves.toBe(true);
    await h.wait((frame) => subtype("fake_input")(frame) && steerText(frame));

    const controls = h.frames
      .filter(subtype("fake_control"))
      .map((frame) => object(object(frame.data)["request"]));
    // Every foreground task moves; nothing is interrupted or stopped.
    expect(controls.filter((request) => request["subtype"] === "background_tasks")).toEqual([
      { subtype: "background_tasks" },
    ]);
    expect(
      controls.filter((request) => ["interrupt", "stop_task"].includes(String(request["subtype"]))),
    ).toEqual([]);

    const state = project(h.frames);
    expect(hasRunningForegroundCommand(state)).toBe(false);
    expect(Object.values(state.tasks)).toMatchObject([
      { title: "Wait for build", kind: "shell", status: "running" },
    ]);
    // Its later end arrives as a background task notification and settles the task.
    const last = h.frames.at(-1);
    const finished = project([
      ...h.frames,
      {
        seq: (last?.seq ?? 0) + 1,
        t: (last?.t ?? 0) + 1,
        dir: "recv",
        channel: "sdk",
        data: {
          type: "system",
          subtype: "task_notification",
          task_id: "wait-task",
          status: "completed",
        },
      },
    ]);
    expect(Object.values(finished.tasks)).toMatchObject([{ status: "completed" }]);
  } finally {
    await h.session.close("shutdown");
  }
});

test("when background tasks are disabled the steer stays held for the command and the session keeps working", async () => {
  const h = await blockedOnCommand({ ACE_FAKE_CLAUDE_BACKGROUND_DISABLED: "1" });
  try {
    await expect(h.session.backgroundTools?.()).rejects.toThrow("Background tasks are disabled");
    expect(h.frames.some((f) => subtype("fake_input")(f) && steerText(f))).toBe(false);
    expect(
      h.frames
        .filter(subtype("fake_control"))
        .map((frame) => object(object(frame.data)["request"])["subtype"]),
    ).not.toContain("interrupt");
    expect(hasRunningForegroundCommand(project(h.frames))).toBe(true);
    expect(h.exits).toEqual([]);
  } finally {
    await h.session.close("shutdown");
  }
});
