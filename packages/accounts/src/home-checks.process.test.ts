// Real temp SQLite and real folders; only the one stalled folder is held at the fs boundary.
import { mkdir, realpath } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import type { ProviderAdapter, SessionContext } from "@ace/engine-api";
import {
  AccountService,
  createInstance,
  initialQuota,
  openRegistry,
  openRegistryIndex,
  type AccountRegistry,
  type HomeCheck,
} from "./index.ts";
import { cleanup, temp } from "./test-support.ts";

afterEach(cleanup);

/** Timers the test fires by hand: `fire(ms)` runs every live timer of that length. */
function manualTimers() {
  const timers: { ms: number; run: () => void; live: boolean }[] = [];
  return {
    after(ms: number, run: () => void) {
      const timer = { ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    live: (ms: number) => timers.some((entry) => entry.live && entry.ms === ms),
    fire(ms: number) {
      for (const timer of timers.filter((entry) => entry.live && entry.ms === ms)) {
        timer.live = false;
        timer.run();
      }
    },
  };
}

/** Two signed-in Claude accounts; "silent" is checked first and its folder never answers. */
async function twoAccounts() {
  const root = await realpath(await temp());
  const path = join(root, "accounts.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY,instance TEXT NOT NULL,quota TEXT NOT NULL)");
  for (const id of ["silent", "working"]) {
    const instance = createInstance({ id, provider: "claude", label: id, homeDir: join(root, id) });
    await mkdir(instance.homeDir);
    db.prepare("INSERT INTO accounts VALUES(?,?,?)").run(
      id,
      JSON.stringify(instance),
      JSON.stringify({ ...initialQuota(), auth: "logged_in", observedAt: 0 }),
    );
  }
  db.close();
  const answer = Promise.withResolvers<void>();
  const check: HomeCheck = (instance, next) =>
    instance.id === "silent" ? answer.promise.then(() => next(instance)) : next(instance);
  const timers = manualTimers();
  const registry = await openRegistryIndex(path, undefined, root, {
    check,
    patienceMs: 10,
    after: timers.after,
  });
  // The silent check outlasts its patience, so the next account's check starts.
  while (!timers.live(10)) await new Promise((resolve) => setTimeout(resolve, 1));
  timers.fire(10);
  await registry.firstPass;
  return { root, registry, answer, timers };
}

function service(registry: AccountRegistry, timers: ReturnType<typeof manualTimers>) {
  const opened: (string | undefined)[] = [];
  const adapter: ProviderAdapter = {
    provider: "claude",
    capabilities: () => {
      throw new Error("unused");
    },
    createTranslator: () => {
      throw new Error("unused");
    },
    openSession: async (context) => {
      opened.push(context.instanceId);
      return {
        nativeSessionId: "native",
        send: async () => {},
        interrupt: async () => {},
        resolve: async () => {},
        stopTask: async () => {},
        close: async () => {},
      };
    },
  };
  const accounts = new AccountService({
    registry,
    now: () => 1,
    timeZone: "UTC",
    env: {},
    after: timers.after,
    homeWait: { noticeMs: 100, limitMs: 1_000 },
  });
  const waits: (readonly string[])[] = [];
  const open = (instanceId?: string) => {
    const context: SessionContext = {
      threadId: ThreadId.parse("thread"),
      cwd: "/tmp",
      signal: new AbortController().signal,
      onFrame: () => {},
      onExit: () => {},
      onAccountWait: (labels) => waits.push(labels),
    };
    return accounts.openSession(adapter, context, {
      ...(instanceId ? { instanceId } : {}),
      role: "worker",
      estimatedLoad: 1,
    });
  };
  return { open, opened, waits };
}

test("a home that never answers leaves its account listed as checking while the others are checked", async () => {
  const { root, registry, answer } = await twoAccounts();
  try {
    // Listed and named, never reported missing; the working account is checked and usable.
    expect(registry.summaries(1).map(({ id, quota }) => [id, quota.blockers])).toEqual([
      ["silent", { homeUnavailable: "home_checking" }],
      ["working", {}],
    ]);
    expect(registry.get("working")?.instance.homeDir).toBe(join(root, "working"));
    expect(
      registry.pickInstance({ provider: "claude", role: "worker", estimatedLoad: 1 }, 1)?.id,
    ).toBe("working");
    const changed: string[] = [];
    registry.subscribeQuota((id) => changed.push(id));
    answer.resolve();
    await registry.checked("silent");
    expect(registry.get("silent")?.quota.blockers).toEqual({});
    expect(changed).toEqual(["silent"]);
  } finally {
    registry.close();
  }
});

test("a session pinned to an account whose home hasn't answered waits for it, says so, and never runs elsewhere", async () => {
  const { registry, answer, timers } = await twoAccounts();
  try {
    const { open, opened, waits } = service(registry, timers);
    const waiting = open("silent");
    // Other accounts' sessions run meanwhile.
    expect((await open("working")).instanceId).toBe("working");
    timers.fire(100);
    expect(waits).toEqual([["silent"]]);
    expect(opened).toEqual(["working"]);
    answer.resolve();
    expect((await waiting).instanceId).toBe("silent");
    expect(opened).toEqual(["working", "silent"]);
  } finally {
    registry.close();
  }
});

test("a pick by limits waits for every candidate's home, so a silent folder never sends its work to another account", async () => {
  const { registry, answer, timers } = await twoAccounts();
  try {
    const { open, opened } = service(registry, timers);
    const picked = open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opened).toEqual([]);
    answer.resolve();
    await picked;
    expect(opened).toHaveLength(1);
  } finally {
    registry.close();
  }
});

test("a session gives up with the reason when the home stays silent, and the next one opens once it answers", async () => {
  const { registry, answer, timers } = await twoAccounts();
  try {
    const { open, opened } = service(registry, timers);
    const waiting = open("silent");
    timers.fire(1_000);
    await expect(waiting).rejects.toMatchObject({
      code: "account_home_unanswered",
      title: expect.stringContaining("“silent”"),
    });
    expect(opened).toEqual([]);
    expect(registry.get("silent")?.quota.blockers.homeUnavailable).toBe("home_checking");
    answer.resolve();
    await registry.checked("silent");
    expect((await open("silent")).instanceId).toBe("silent");
  } finally {
    registry.close();
  }
});

test("opening the index for a one-off read returns while a folder stays silent", async () => {
  const root = await realpath(await temp());
  const path = join(root, "accounts.sqlite");
  const seeded = await openRegistry(path, root);
  for (const id of ["silent", "working"]) {
    await mkdir(join(root, id));
    await seeded.register(
      createInstance({ id, provider: "claude", label: id, homeDir: join(root, id) }),
    );
  }
  seeded.close();
  const registry = await openRegistry(path, root, {
    check: (instance, next) =>
      instance.id === "silent" ? new Promise<never>(() => {}) : next(instance),
    patienceMs: 10,
  });
  try {
    // Returned with the silent folder still unanswered; the other answers on its own.
    expect(registry.isChecking("silent")).toBe(true);
    await registry.checked("working");
    expect(registry.summaries(1).map(({ id, quota }) => [id, quota.blockers])).toEqual([
      ["silent", { homeUnavailable: "home_checking" }],
      ["working", {}],
    ]);
  } finally {
    registry.close();
  }
});
