import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";
import { createCodexAdapter } from "./index.ts";
import { replayHarness } from "./replay.test-helper.ts";
export async function sessionHarness(resume = false) {
  const directory = await mkdtemp(join(tmpdir(), "ace-codex-session-"));
  const binary = join(directory, "codex.mjs");
  await writeFile(
    binary,
    `#!${process.execPath}\nimport ${JSON.stringify(new URL("./testing/cli.ts", import.meta.url).href)};\n`,
  );
  await chmod(binary, 0o755);
  const adapter = createCodexAdapter({
    discovery: { overrides: { codex: binary } },
    cli: {
      installed: true,
      path: binary,
      version: "0.159.1",
      auth: "logged_in",
      loginHint: "unused",
    },
  });
  const controller = new AbortController();
  const replay = replayHarness();
  const frames: Frame[] = [];
  const waiters = new Set<{ match(frame: Frame): boolean; resolve(frame: Frame): void }>();
  let exitResolve: (exit: { deliberate: boolean; message?: string }) => void = () => {};
  const exited = new Promise<{ deliberate: boolean; message?: string }>((resolve) => {
    exitResolve = resolve;
  });
  const session = await adapter.openSession({
    threadId: ThreadId.parse("fixture"),
    cwd: directory,
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
    onExit(exit) {
      replay.feedFact({ type: "process.exited", ...exit }, frames.at(-1)?.t ?? 0);
      exitResolve(exit);
    },
  });
  return {
    session,
    frames,
    replay,
    controller,
    exited,
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
