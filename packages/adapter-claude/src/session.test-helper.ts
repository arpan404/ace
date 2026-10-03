import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Frame, SessionContext } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";
import { afterEach, beforeEach } from "vitest";
import { createClaudeAdapter, type ClaudeOptions } from "./index.ts";
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
export async function harness(
  resume?: string,
  rootKey = "root",
  options: ClaudeOptions = {},
  execution: Pick<SessionContext, "fork" | "options" | "aceMcp" | "permissionMode"> = {},
) {
  const frames: Frame[] = [];
  const waiters: { predicate(frame: Frame): boolean; resolve(frame: Frame): void }[] = [];
  const exit = Promise.withResolvers<{ deliberate: boolean; message?: string }>();
  const exits: { deliberate: boolean; message?: string }[] = [];
  const controller = new AbortController();
  const adapter = createClaudeAdapter({ executable, ...options });
  const session = await adapter.openSession({
    rootKey,
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
    ...execution,
    onExit: (value) => {
      exits.push(value);
      exit.resolve(value);
    },
  });
  function wait(predicate: (frame: Frame) => boolean) {
    const prior = frames.find(predicate);
    if (prior) return Promise.resolve(prior);
    return new Promise<Frame>((resolve) => waiters.push({ predicate, resolve }));
  }
  return { session, wait, frames, exit: exit.promise, exits, controller };
}
export const subtype = (value: string) => (frame: Frame) => object(frame.data)["subtype"] === value;
