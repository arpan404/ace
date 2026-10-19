import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSession } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";
import { CodexHostPool } from "./host-pool.ts";
import { createCodexAdapter } from "./index.ts";
import { holdCodexThread } from "./thread-lease.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const native = "11111111-1111-4111-8111-111111111111";

// The synthetic CLI takes a per-thread writer lock on resume and keeps it while the thread is
// loaded, as Codex does; only a process launched to unload closed threads gives it up on close.
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ace-codex-lease-"));
  const cli = join(root, "codex.mjs");
  await writeFile(
    cli,
    `#!${process.execPath}\nimport ${JSON.stringify(new URL("./testing/shared-cli.ts", import.meta.url).href)};\n`,
    { mode: 0o700 },
  );
  const env = { ACE_FAKE_CODEX_WRITER_ROOT: join(root, "writers") };
  const pool = new CodexHostPool();
  const sessions: ProviderSession[] = [];
  cleanups.push(async () => {
    for (const session of sessions) await session.close("shutdown");
    await pool.close();
    await rm(root, { recursive: true, force: true });
  });
  const adapter = createCodexAdapter({
    hosts: pool,
    cli: { installed: true, path: cli, version: "0.159.1", auth: "unknown", loginHint: "fake" },
    runtime: { stopGraceMs: 0, homeDir: () => root },
  });
  const open = async (threadId: string) => {
    const session = await adapter.openSession({
      threadId: ThreadId.parse(threadId),
      cwd: root,
      env,
      signal: new AbortController().signal,
      resume: { nativeSessionId: native },
      onFrame() {},
      onExit() {},
    });
    sessions.push(session);
    return session;
  };
  const hold = (attempts = 1) =>
    holdCodexThread({
      executable: cli,
      env,
      cwd: root,
      signal: new AbortController().signal,
      threadId: native,
      attempts,
      wait: async () => {},
    });
  return { open, hold };
}

test("a thread ace closed can be held by another Codex process, which excludes every other writer until released", async () => {
  const { open, hold } = await setup();
  const session = await open("thread");
  await session.close("idle");

  const lease = await hold();
  expect(lease.held).toBe(true);
  // While the lease holds the thread, neither another process nor ace can write it.
  expect(await hold()).toEqual({ held: false, reason: expect.any(String) });
  await expect(open("thread")).rejects.toThrow(/active writer/);
  if (lease.held) await lease.release();

  expect((await hold()).held).toBe(true);
});

test("a thread a live ace session still has open is reported busy after every attempt", async () => {
  const { open, hold } = await setup();
  await open("thread");
  expect(await hold(3)).toEqual({
    held: false,
    reason: "Another Codex process has this conversation open",
  });
});
