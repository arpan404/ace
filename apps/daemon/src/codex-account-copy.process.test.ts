import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { AccountService, createInstance, openRegistry } from "@ace/accounts";
import { CodexHostPool, createCodexAdapter } from "@ace/adapter-codex";
import { holdCodexThread } from "@ace/adapter-codex/thread-lease";
import { ThreadId } from "@ace/protocol";
import type { ProviderSession } from "@ace/engine-api";
import { providerMigrationSafety } from "./account-leases.ts";
import { accountTransitions } from "./services/thread-transitions.ts";

const native = "11111111-1111-4111-8111-111111111111";
const rollout = join("sessions", "2026", "10", "19", `rollout-2026-10-19T10-00-00-${native}.jsonl`);
const history = `${JSON.stringify({ type: "session_meta", payload: { id: native, session_id: native, history_mode: "paginated" } })}\n${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "durable history" }] } })}\n`;

// The synthetic Codex CLI takes a per-thread writer lock on resume, as Codex does, and keeps it
// while the thread is loaded. The switch locks the thread through that same CLI.
test("a closed Codex thread copies to another account under Codex's lock while a neighbour keeps working", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-codex-copy-"));
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
    const homes = { a: join(root, "a"), b: join(root, "b") };
    await mkdir(join(homes.a, "sessions", "2026", "10", "19"), { recursive: true });
    await mkdir(homes.b);
    await writeFile(join(homes.a, rollout), history);
    for (const [id, homeDir] of Object.entries(homes))
      await registry.register(createInstance({ id, provider: "codex", label: id, homeDir }));
    const env: NodeJS.ProcessEnv = { ACE_FAKE_CODEX_WRITER_ROOT: join(root, "writers") };
    const accounts = new AccountService({
      registry,
      now: () => 1,
      timeZone: "UTC",
      env,
      safety: providerMigrationSafety({
        env,
        cwd: root,
        signal: new AbortController().signal,
        discovery: { overrides: { codex: cli } },
        hold: (options) => holdCodexThread({ ...options, attempts: 2, wait: async () => {} }),
      }),
    });
    const adapter = createCodexAdapter({
      hosts: pool,
      cli: { installed: true, path: cli, version: "0.159.1", auth: "unknown", loginHint: "fake" },
      runtime: { stopGraceMs: 0, homeDir: () => root },
    });
    const turn = z.object({ method: z.string(), params: z.object({ turn: z.unknown() }) });
    const open = async (name: string, resume?: string) => {
      const completed = Promise.withResolvers<unknown>();
      const started = Promise.withResolvers<void>();
      const exits: boolean[] = [];
      const { session } = await accounts.openSession(
        adapter,
        {
          threadId: ThreadId.parse(name),
          cwd: root,
          signal: new AbortController().signal,
          ...(resume ? { resume: { nativeSessionId: resume } } : {}),
          onFrame(frame) {
            const event = turn.safeParse(frame.data);
            if (!event.success || frame.dir !== "recv") return;
            if (event.data.method === "turn/started") started.resolve();
            if (event.data.method === "turn/completed") completed.resolve(event.data.params.turn);
          },
          onExit: (exit) => exits.push(exit.deliberate),
        },
        { instanceId: "a", role: "worker", estimatedLoad: 1 },
      );
      sessions.push(session);
      return { session, started: started.promise, completed: completed.promise, exits };
    };
    const migrate = accountTransitions({
      now: () => 1,
      id: () => "copy",
      services: { accounts, accountRegistry: registry },
    }).migrate;
    const request = { provider: "codex" as const, nativeSessionId: native, from: "a", to: "b" };

    const moving = await open("moving", native);
    await moving.session.send([{ type: "text", text: "first turn" }], "queue");
    await moving.completed;
    const neighbour = await open("neighbour");
    await neighbour.session.send([{ type: "text", text: "hold" }], "queue");
    await neighbour.started;

    // Still open in ace: Codex holds the thread, so nothing is copied and nothing changes.
    expect(await migrate(request)).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("open somewhere else"),
    });
    expect(await readdir(homes.b)).toEqual([]);

    await moving.session.close("idle");
    expect(await migrate(request)).toMatchObject({
      status: "migrated",
      nativeSessionId: native,
      action: "fork",
      copiedFiles: 1,
    });
    expect(await readFile(join(homes.b, rollout), "utf8")).toBe(history);
    expect(await readFile(join(homes.a, rollout), "utf8")).toBe(history);

    // The lock is released: account A can reopen the thread, and the neighbour never stopped.
    const back = await open("moving", native);
    expect(back.session.nativeSessionId).toBe(native);
    expect(neighbour.exits).toEqual([]);
    await neighbour.session.interrupt({ agent: "root", cascade: false });
    expect(await neighbour.completed).toMatchObject({ status: "interrupted" });
  } finally {
    for (const session of sessions.toReversed()) await session.close("shutdown");
    await pool.close();
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
