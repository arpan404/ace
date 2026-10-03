import { apply, createThreadState, type Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { spawnTextSupervised } from "@ace/provider-kit/process";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFixture } from "./native-history.ts";
import { createPiTranslator, openPiSession, type PiOptions } from "../index.ts";
export function replay() {
  const threadId = ThreadId.parse("pi-test");
  const translator = createPiTranslator({ threadId, rootKey: "root" });
  const state = createThreadState({
    threadId,
    config: { provider: "pi", silenceMs: 60_000 },
    rootAgent: {
      agent: "root",
      fidelity: "full",
      native: { provider: "pi", nativeId: "native" },
      cwd: "/synthetic",
    },
  });
  let ids = 0,
    seq = 0;
  const facts = (values: Fact[], now: number) => {
    for (const fact of values)
      apply(state, fact, { now, ids: { next: (kind) => `${kind}-${++ids}` } });
  };
  const frame = (value: Frame) => facts(translator.translate(value, value.t), value.t);
  return {
    threadId,
    translator,
    get state() {
      return state;
    },
    facts,
    frame,
    recv(data: unknown, now = 0) {
      frame({ seq: seq++, t: now, dir: "recv", channel: "stdio", data });
    },
    send(data: unknown, now = 0) {
      frame({ seq: seq++, t: now, dir: "send", channel: "stdio", data });
    },
  };
}
export async function sessionHarness(
  options: PiOptions = {},
  resume: boolean | string = false,
  env: NodeJS.ProcessEnv = {},
  existingHome?: string,
) {
  const home = existingHome ?? (await mkdtemp(join(tmpdir(), "ace-pi-session-")));
  const sourcePath = join(home, "source.jsonl"),
    resumedPath = join(home, "resumed.jsonl");
  if (!existingHome) {
    await writeFile(sourcePath, sessionFixture(home, "native", 3));
    await writeFile(resumedPath, sessionFixture(home, "resumed-native", 3));
  }
  const h = replay(),
    frames: Frame[] = [],
    timers = new Map<number, { callback: () => void; ms: number }>();
  let timerId = 0,
    secretId = 0;
  const pending = new Set<{ predicate: (f: Frame) => boolean; resolve: (f: Frame) => void }>();
  const controller = new AbortController();
  let session;
  try {
    session = await openPiSession(
      {
        threadId: h.threadId,
        rootKey: "root",
        cwd: process.cwd(),
        env: { ...env, FAKE_PI_HOME: home },
        signal: controller.signal,
        ...(resume
          ? { resume: { nativeSessionId: typeof resume === "string" ? resume : resumedPath } }
          : {}),
        onFrame(frame) {
          frames.push(frame);
          h.frame(frame);
          for (const waiter of pending)
            if (waiter.predicate(frame)) {
              pending.delete(waiter);
              waiter.resolve(frame);
            }
        },
        onExit(exit) {
          h.facts([{ type: "process.exited", ...exit }], 0);
        },
      },
      {
        ...options,
        cli: {
          installed: true,
          path: "synthetic-pi",
          version: "0.85.1",
          auth: "unknown",
          loginHint: "none",
        },
        runtime: {
          now: () => 0,
          secret: () => (++secretId).toString(16).padStart(64, "0"),
          schedule: (callback, ms) => {
            const id = ++timerId;
            timers.set(id, { callback, ms });
            return () => timers.delete(id);
          },
          spawn: (spawnOptions) =>
            spawnTextSupervised({
              ...spawnOptions,
              command: process.execPath,
              args: [
                fileURLToPath(new URL("./fake-pi.ts", import.meta.url)),
                ...(spawnOptions.args ?? []),
              ],
            }),
          ...options.runtime,
        },
      },
    );
  } catch (error) {
    if (!existingHome) await rm(home, { recursive: true, force: true });
    throw error;
  }
  return {
    home,
    sourcePath,
    resumedPath,
    h,
    session,
    frames,
    wait(predicate: (f: Frame) => boolean) {
      const found = frames.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise<Frame>((resolve) => pending.add({ predicate, resolve }));
    },
    expireDialogs() {
      for (const [id, t] of timers)
        if (t.ms === 25) {
          timers.delete(id);
          t.callback();
        }
    },
    async dispose() {
      await session.close("shutdown");
      controller.abort();
      if (!existingHome) await rm(home, { recursive: true, force: true });
    },
  };
}
