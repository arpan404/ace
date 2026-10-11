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
async function setup(quirks = extensionQuirks) {
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
    expect(Object.values(h.state.tasks).map((task) => task.status)).toEqual(["completed"]);
  } finally {
    await h.session.close("shutdown");
  }
});
it("rejects reprompting while an Antigravity shell survives a normal prompt end", async () => {
  const h = await setup(antigravityQuirks);
  try {
    await h.session.send(input("antigravity-shell"), "queue");
    expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
    await expect(h.session.send(input("next"), "queue")).rejects.toThrow("shell");
    expect(promptCount(h.frames)).toBe(1);
  } finally {
    await h.session.close("shutdown");
  }
});
