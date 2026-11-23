import { extensionQuirks } from "./testing/extension-quirks.ts";
import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";
import { apply, createThreadState } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import {
  openAcpSession,
  createAcpTranslator,
  antigravityQuirks,
  createTranslatorIdentity,
} from "./index.ts";
import { object } from "./data.ts";
async function setup(quirks = extensionQuirks, resume = false, version = "1.2.1") {
  const threadId = ThreadId.parse("shell-queue");
  const state = createThreadState({
    threadId,
    config: { provider: quirks.provider, silenceMs: 90_000 },
  });
  const translator = createAcpTranslator(
    { threadId, rootKey: "root", identity: createTranslatorIdentity("queue-test") },
    quirks,
  );
  const frames: Frame[] = [];
  const watchers = new Set<() => void>();
  let ids = 0;
  const session = await openAcpSession(
    {
      threadId,
      cwd: process.cwd(),
      signal: new AbortController().signal,
      ...(resume ? { resume: { nativeSessionId: "native-root" } } : {}),
      onFrame(frame) {
        frames.push(frame);
        for (const fact of translator.translate(frame, frame.t))
          apply(state, fact, { now: frame.t, ids: { next: () => `id-${++ids}` } });
        for (const watcher of watchers) watcher();
      },
      onExit() {},
    },
    quirks,
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("./testing/uncertain-shell-server.ts", import.meta.url))],
      version,
    },
  );
  function wait(predicate: (frame: Frame) => boolean): Promise<Frame> {
    return new Promise((resolve) => {
      const check = () => {
        const found = frames.find(predicate);
        if (found) {
          watchers.delete(check);
          resolve(found);
        }
      };
      watchers.add(check);
      check();
    });
  }
  return { session, state, frames, wait };
}
const input = (text: string) => [{ type: "text" as const, text }];
const promptCount = (frames: Frame[]) =>
  frames.filter(
    (frame) => frame.dir === "send" && object(frame.data)["method"] === "session/prompt",
  ).length;
it("rejects another prompt while a cancelled shell has no terminal execution evidence", async () => {
  const h = await setup();
  try {
    await h.session.send(input("shell"), "queue");
    expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
    await expect(h.session.send(input("next"), "queue")).rejects.toThrow("shell");
    expect(promptCount(h.frames)).toBe(1);
  } finally {
    await h.session.close("shutdown");
  }
});
it("rejects input queued before a prompt reports uncertain shell completion", async () => {
  const h = await setup();
  try {
    const first = h.session.send(input("shell"), "queue");
    const second = expect(h.session.send(input("next"), "queue")).rejects.toThrow("shell");
    await Promise.all([first, second]);
    expect(promptCount(h.frames)).toBe(1);
    expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
  } finally {
    await h.session.close("shutdown");
  }
});
it("accepts new input after terminal execution evidence settles a cancelled shell", async () => {
  const h = await setup();
  try {
    await h.session.send(input("controlled-shell"), "queue");
    await h.wait((frame) => object(frame.data)["method"] === "session/request_permission");
    await expect(h.session.send(input("next"), "queue")).rejects.toThrow("shell");
    await h.session.resolve("request:number:100", { kind: "approval", optionId: "a" });
    await h.wait(
      (frame) => object(object(object(frame.data)["params"])["update"])["status"] === "completed",
    );
    await h.session.send(input("next"), "queue");
    expect(promptCount(h.frames)).toBe(2);
    expect(h.state.status.state).toBe("done");
    // The shell, and the release tool that ran after the prompt and held the next one: both ended.
    expect(
      Object.values(h.state.tasks).map((task) => [task.kind, task.blocksPrompts, task.status]),
    ).toEqual([
      ["shell", true, "completed"],
      ["other", true, "completed"],
    ]);
  } finally {
    await h.session.close("shutdown");
  }
});
it("takes a new prompt beside an Antigravity shell left running after a finished turn, and that prompt's report ends it", async () => {
  const h = await setup(antigravityQuirks);
  try {
    await h.session.send(input("antigravity-shell"), "queue");
    expect(h.state.status.state).toBe("done");
    await h.session.send(input("report-shell"), "queue");
    expect(promptCount(h.frames)).toBe(2);
    expect(Object.values(h.state.tasks).map((task) => [task.kind, task.status])).toEqual([
      ["shell", "completed"],
    ]);
    // Nothing left unconfirmed: the next message goes in too.
    await h.session.send(input("next"), "queue");
    expect(promptCount(h.frames)).toBe(3);
  } finally {
    await h.session.close("shutdown");
  }
});
it("a steer joins a running Antigravity 1.5 turn as a prompt of its own, without cancelling it", async () => {
  const h = await setup(antigravityQuirks, false, "1.5.2");
  try {
    const first = h.session.send(input("steerable"), "queue");
    await h.wait(
      (frame) => object(object(object(frame.data)["params"])["update"])["toolCallId"] === "held",
    );
    await h.session.send(input("change course"), "steer");
    // Taken once written; the turn the steer joined is still running.
    expect(h.state.status.state).toBe("working");
    await first;
    // The earlier prompt answered as the steer took over: the turn goes on under the steer.
    expect(h.state.status.state).toBe("working");
    const steerId = object(
      h.frames.findLast(
        (frame) => frame.dir === "send" && object(frame.data)["method"] === "session/prompt",
      )?.data,
    )["id"];
    await h.wait(
      (frame) =>
        frame.dir === "recv" &&
        object(frame.data)["id"] === steerId &&
        "result" in object(frame.data),
    );
    expect(h.state.status.state).toBe("done");
    expect(Object.values(h.state.runs).map((run) => run.state)).toEqual(["completed"]);
    expect(h.frames.some((frame) => object(frame.data)["method"] === "session/cancel")).toBe(false);
    expect(promptCount(h.frames)).toBe(2);
  } finally {
    await h.session.close("shutdown");
  }
});
it("before Antigravity 1.5 a steer waits for the running turn instead of overlapping it", async () => {
  const h = await setup(antigravityQuirks);
  try {
    void h.session.send(input("steerable"), "queue");
    await h.wait(
      (frame) => object(object(object(frame.data)["params"])["update"])["toolCallId"] === "held",
    );
    const steer = h.session.send(input("change course"), "steer");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(promptCount(h.frames)).toBe(1);
    expect(h.session.steerViaCancel).toBe(true);
    void steer.catch(() => {});
  } finally {
    await h.session.close("shutdown");
  }
});
/** Fails instead of hanging when the session never takes the input. */
const taken = (sent: Promise<void>) =>
  Promise.race([
    sent,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("input was never taken")), 2_000),
    ),
  ]);
it("takes new input after the person denies an Antigravity shell that never ran", async () => {
  const h = await setup(antigravityQuirks);
  try {
    const first = h.session.send(input("denied-shell"), "queue");
    await h.wait((frame) => object(frame.data)["method"] === "session/request_permission");
    await h.session.resolve("request:number:101", { kind: "approval", optionId: "no" });
    await first;
    await taken(h.session.send(input("next"), "queue"));
    expect(promptCount(h.frames)).toBe(2);
    expect(h.state.status.state).toBe("done");
  } finally {
    await h.session.close("shutdown");
  }
});
it("takes new input after an Antigravity prompt ends with a shell still awaiting approval", async () => {
  const h = await setup(antigravityQuirks);
  try {
    await h.session.send(input("unanswered-shell"), "queue");
    await taken(h.session.send(input("next"), "queue"));
    expect(promptCount(h.frames)).toBe(2);
    expect(h.state.status.state).toBe("done");
  } finally {
    await h.session.close("shutdown");
  }
});
it("takes new input after an error reply ends a prompt with a running Antigravity shell", async () => {
  const h = await setup(antigravityQuirks);
  try {
    await expect(h.session.send(input("failing-shell"), "queue")).rejects.toThrow();
    await taken(h.session.send(input("next"), "queue"));
    expect(promptCount(h.frames)).toBe(2);
    expect(Object.values(h.state.tasks)).toEqual([]);
  } finally {
    await h.session.close("shutdown");
  }
});
it("a loaded session's replayed shell and child never hold back new input", async () => {
  const h = await setup(antigravityQuirks, true);
  try {
    await taken(h.session.send(input("plain"), "queue"));
    await taken(h.session.send(input("next"), "queue"));
    expect(promptCount(h.frames)).toBe(2);
    expect(h.state.status.state).toBe("done");
  } finally {
    await h.session.close("shutdown");
  }
});
