import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { AccountService, createInstance, openRegistry } from "@ace/accounts";
import { CodexHostPool, createCodexAdapter } from "@ace/adapter-codex";
import { ThreadId } from "@ace/protocol";
import type { Frame, ProviderSession } from "@ace/engine-api";

test("an idle Codex thread reopens beside live work after a library changes the daemon environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-codex-writer-"));
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  const pool = new CodexHostPool();
  const sessions: ProviderSession[] = [];
  try {
    const cli = join(root, "codex.mjs");
    await writeFile(
      cli,
      `#!${process.execPath}\nimport ${JSON.stringify(new URL("../../../packages/adapter-codex/src/testing/shared-cli.ts", import.meta.url).href)};\n`,
      { mode: 0o700 },
    );
    await registry.register(
      createInstance({ id: "work", provider: "codex", label: "Work", homeDir: root }),
    );
    const ambient: NodeJS.ProcessEnv = { ACE_FAKE_CODEX_WRITER_ROOT: join(root, "writers") };
    const accounts = new AccountService({ registry, now: () => 1, timeZone: "UTC", env: ambient });
    const adapter = createCodexAdapter({
      hosts: pool,
      cli: { installed: true, path: cli, version: "0.159.1", auth: "unknown", loginHint: "fake" },
      runtime: { stopGraceMs: 0, homeDir: () => root },
    });
    const open = async (name: string, nativeSessionId?: string) => {
      const frames: Frame[] = [];
      const started = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<unknown>();
      const exits: boolean[] = [];
      const turnEvent = z.object({ method: z.string(), params: z.object({ turn: z.unknown() }) });
      const { session } = await accounts.openSession(
        adapter,
        {
          threadId: ThreadId.parse(name),
          cwd: root,
          signal: new AbortController().signal,
          ...(nativeSessionId ? { resume: { nativeSessionId } } : {}),
          onFrame(frame) {
            frames.push(frame);
            const event = turnEvent.safeParse(frame.data);
            if (!event.success || frame.dir !== "recv") return;
            if (event.data.method === "turn/started") started.resolve();
            if (event.data.method === "turn/completed") completed.resolve(event.data.params.turn);
          },
          onExit: (exit) => exits.push(exit.deliberate),
        },
        { provider: "codex", instanceId: "work", role: "worker", estimatedLoad: 1 },
      );
      sessions.push(session);
      const initialized = z.object({ result: z.object({ pid: z.number() }) });
      const pid = frames
        .map((frame) => initialized.safeParse(frame.data))
        .find((parsed) => parsed.success)?.data?.result.pid;
      return { session, started: started.promise, completed: completed.promise, pid, exits };
    };
    const first = await open("first");
    await first.session.send([{ type: "text", text: "initial turn" }], "queue");
    await first.completed;
    const neighbour = await open("neighbour");
    await neighbour.session.send([{ type: "text", text: "hold" }], "queue");
    await neighbour.started;
    await first.session.close("idle");

    // sharp sets this on process.env when lazily loaded, after AccountService starts.
    ambient.VIPSHOME = "/late-loaded-image-library";
    const reopened = await open("first", first.session.nativeSessionId);
    expect(reopened.session.nativeSessionId).toBe(first.session.nativeSessionId);
    expect(first.pid).toBeDefined();
    expect(reopened.pid).toBe(first.pid);
    expect(neighbour.exits).toEqual([]);
    await reopened.session.send([{ type: "text", text: "follow-up" }], "queue");
    expect(await reopened.completed).toMatchObject({ status: "completed" });
    await neighbour.session.interrupt({ agent: "root", cascade: false });
    expect(await neighbour.completed).toMatchObject({ status: "interrupted" });
    expect(neighbour.exits).toEqual([]);
  } finally {
    for (const session of sessions.toReversed()) await session.close("shutdown");
    await pool.close();
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
