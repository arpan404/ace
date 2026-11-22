// Real edges: daemon processes killed at exact commit points, the real Cursor host over a fake
// SDK, and the SDK's own SQLite store. No provider is contacted.
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store, Engine, AdapterRegistry } from "@ace/daemon";
import { Command } from "@ace/protocol";
import {
  realHostAdapter,
  seedStore,
  threadId,
  writeHostEntry,
} from "./cursor-real-host-support.ts";

/** Runs `script` as a daemon process until it reports its kill point, then kills it there. */
async function killedAt(script: string, args: string[]) {
  const child = fork(new URL(script, import.meta.url), args, {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exit = once(child, "exit");
  try {
    await Promise.race([
      once(child, "message"),
      exit.then(() => {
        throw new Error(`${script} exited before its kill point`);
      }),
    ]);
  } finally {
    child.kill("SIGKILL");
    await exit;
  }
}

/** Boot two: frozen right after it commits a frame of kind `kind`, then killed there. */
async function frozenAt(...args: [string, string, string, string, string, string]) {
  const signal = args[5];
  const child = fork(new URL("./cursor-real-host-child.ts", import.meta.url), args, {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exit = once(child, "exit");
  try {
    await expect.poll(() => existsSync(signal), { timeout: 30_000, interval: 20 }).toBe(true);
  } finally {
    child.kill("SIGKILL");
    await exit;
  }
}

/**
 * Boot one is killed at `window` of its first send; boot two, a daemon whose Cursor opens the
 * real host over `seeded`, is killed right after it commits a frame of kind `secondKill`; boot
 * three runs here. Returns what boot three's host was asked to send, and the thread's end state.
 */
async function twoCrashes(
  window: "attempted" | "admitted-followup",
  seeded: Parameters<typeof seedStore>[2] | undefined,
  secondKill: string,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-second-crash-")));
  const database = join(root, "state.sqlite");
  const home = join(root, "home");
  const sends = join(root, "sends.ndjson");
  await writeFile(sends, "");
  const entry = await writeHostEntry(join(root, "host.ts"));
  await killedAt("./cursor-recovery-child.ts", [database, root, window]);
  // Created after boot one's attempt, as the SDK would have created it.
  if (seeded) await seedStore(home, root, { ...seeded, createdAt: Date.now() });
  else await seedStore(home, root, { status: "finished", texts: [], createdAt: 1, none: true });
  await frozenAt(database, entry, home, sends, secondKill, join(root, "frozen"));
  // Boot two's host is gone with it; nothing it sent counts for boot three.
  await writeFile(sends, "");
  const store = new Store(database);
  const registry = new AdapterRegistry();
  registry.register(realHostAdapter(entry, home, sends), {
    installed: true,
    auth: "logged_in",
    loginHint: "offline",
  });
  const engine = new Engine(store, { registry, selectInstance: () => "account-a" });
  await engine.flush();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await engine.flush();
  const sent = (await readFile(sends, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.stringify(JSON.parse(line)));
  const items = store.readItems(threadId, store.headSeq() + 1, 200).items;
  const read = async () =>
    (await readFile(sends, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.stringify(JSON.parse(line)));
  const result = {
    sent,
    /** The person presses Resume; `sent` then says what that sent. */
    async resume() {
      engine.handler.handle(
        Command.parse({
          id: "resume",
          deviceId: "device",
          payload: {
            type: "queue.resume",
            threadId,
            expectedRevision: engine.queue(threadId).revision,
          },
        }),
        store,
      );
      await engine.flush();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await engine.flush();
      result.sent = await read();
    },
    queue: engine.queue(threadId),
    answers: items.flatMap((item) =>
      item.type === "message" && item.role === "assistant"
        ? [item.parts.map((part) => (part.type === "text" ? part.text : "")).join("")]
        : [],
    ),
    async [Symbol.asyncDispose]() {
      await engine.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return result;
}

it("a completed turn's restart hold goes with it, so after a crash right then Resume sends only the follow-up", async () => {
  await using run = await twoCrashes(
    "admitted-followup",
    {
      status: "finished",
      result: "before and after",
      texts: ["before", " and after"],
      createdAt: Date.now(),
    },
    "recovery",
  );
  // The follow-up waits for the person, as messages queued before a restart do, and no
  // "continue" waits with it: the turn it would continue had finished.
  expect(run.sent).toEqual([]);
  expect(run.queue.messages.map((message) => message.id)).toEqual(["follow-up"]);
  expect(run.answers[0]).toBe("before and after");
  await run.resume();
  expect(run.sent).toHaveLength(1);
  expect(run.sent[0]).toContain("follow-up");
}, 60_000);

it("a send Cursor had is settled on the next start when the reopen that read its run was killed first", async () => {
  await using run = await twoCrashes(
    "attempted",
    { status: "finished", result: "answered", texts: ["answered"], createdAt: Date.now() },
    "recovery",
  );
  expect(run.sent).toEqual([]);
  expect(run.queue.reason).not.toBe("uncertain");
  expect(run.queue).toMatchObject({ pendingCount: 0 });
  expect(run.answers).toEqual(["answered"]);
}, 60_000);

it("a send Cursor never had is sent once on the next start when the reopen that read it was killed first", async () => {
  await using run = await twoCrashes("attempted", undefined, "admission");
  expect(run.sent).toHaveLength(1);
  expect(run.sent[0]).toContain("first");
  expect(run.queue.reason).not.toBe("uncertain");
}, 60_000);
