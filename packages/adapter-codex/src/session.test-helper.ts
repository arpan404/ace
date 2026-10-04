import type { CodexSessionContext } from "./session-context.ts";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame, SessionContext } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";
import { createCodexAdapter } from "./index.ts";
import { requestKey } from "./native.ts";
import { replayHarness } from "./replay.test-helper.ts";
export async function sessionHarness(
  resume = false,
  mode = "",
  fork?: SessionContext["fork"],
  options?: SessionContext["options"],
  aceMcp?: SessionContext["aceMcp"],
  permissionMode?: SessionContext["permissionMode"],
  policy?: Pick<CodexSessionContext, "getPermissionMode">,
) {
  const directory = await mkdtemp(join(tmpdir(), "ace-codex-session-"));
  const binary = join(directory, "codex.mjs");
  await writeFile(
    binary,
    `#!${process.execPath}\nimport ${JSON.stringify(new URL("./testing/cli.ts", import.meta.url).href)};\n`,
  );
  await chmod(binary, 0o755);
  let now = 0;
  const scheduled = new Map<() => void, number>();
  const adapter = createCodexAdapter({
    runtime: {
      stopGraceMs: 0,
      now: () => now,
      userMessageId: () => "offline-message",
      sessionId: () => "offline-session",
      schedule(callback, delay) {
        scheduled.set(callback, delay);
        return () => {
          scheduled.delete(callback);
        };
      },
    },
    discovery: { overrides: { codex: binary }, env: { ACE_FAKE_RESUME: mode, PATH: directory } },
  });
  const controller = new AbortController();
  const replay = replayHarness();
  const frames: Frame[] = [];
  const exits: { deliberate: boolean; message?: string }[] = [];
  const waiters = new Set<{ match(frame: Frame): boolean; resolve(frame: Frame): void }>();
  const exit = Promise.withResolvers<{ deliberate: boolean; message?: string }>();
  const exited = exit.promise;
  const context: CodexSessionContext = {
    threadId: ThreadId.parse("fixture"),
    cwd: directory,
    ...policy,
    interactionId: (key: string) => replay.state.interactions[key]?.id,
    ...(permissionMode ? { permissionMode } : {}),
    ...(fork ? { fork } : {}),
    ...(options ? { options } : {}),
    ...(aceMcp ? { aceMcp } : {}),
    ...(resume ? { resume: { nativeSessionId: "native" } } : {}),
    signal: controller.signal,
    onFrame(frame) {
      frames.push(frame);
      replay.feed(frame);
      for (const waiter of waiters)
        if (waiter.match(frame)) {
          waiters.delete(waiter);
          waiter.resolve(frame);
        }
    },
    onExit(result) {
      exits.push(result);
      replay.feedFact({ type: "process.exited", ...result }, frames.at(-1)?.t ?? 0);
      exit.resolve(result);
    },
  };
  const session = await adapter.openSession(context);
  return {
    cwd: directory,
    session,
    requestKey: (id: unknown) => requestKey(id, "offline-session"),
    frames,
    replay,
    controller,
    exited,
    exits,
    runTimers() {
      const due = Array.from(scheduled);
      for (const [callback, delay] of due) {
        scheduled.delete(callback);
        now += delay;
        callback();
      }
    },
    wait(match: (frame: Frame) => boolean) {
      const previous = frames.find(match);
      if (previous) return Promise.resolve(previous);
      return new Promise<Frame>((resolve) => waiters.add({ match, resolve }));
    },
    async dispose() {
      await session.close("shutdown");
      await rm(directory, { recursive: true, force: true });
    },
  };
}
