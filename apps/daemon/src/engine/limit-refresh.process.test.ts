import { afterEach, expect, test } from "vitest";
import type { ThreadId } from "@ace/protocol";
import type { ReadCliUsage } from "../account-limits.ts";
import { limitsRefreshMs } from "../account-management.ts";
import { cleanupRecovery, dispatch, sends } from "./recovery-test-support.ts";
import {
  clearedThen,
  codexThread,
  minute,
  reading,
  frame,
  started,
  turn,
} from "./codex-limit-test-support.ts";

/*
 * Whether account limits are re-read while a thread is held at one, through the engine, the
 * account registry and account management as the daemon wires them: no client is attached, the
 * held thread's provider session has ended, and only the engine's own state says a reading
 * matters. The stand-in for each account's `codex app-server` answers from `quota`.
 */

afterEach(cleanupRecovery);

/**
 * Every account at 100% until set otherwise, as Codex reads it: its window always resets five
 * hours on from the read. Counts reads per account home.
 */
function fakeCodex(now: () => number) {
  const used = new Map<string, number>();
  const reads = new Map<string, number>();
  const read: ReadCliUsage = async ({ env }) => {
    const home = env.CODEX_HOME ?? "";
    reads.set(home, (reads.get(home) ?? 0) + 1);
    return reading(used.get(home) ?? 100, now() + 300 * minute);
  };
  return {
    read,
    set: (home: string, percent: number) => used.set(home, percent),
    reads: () => [...reads.values()].reduce((sum, count) => sum + count, 0),
    readsOf: (home: string) => reads.get(home) ?? 0,
  };
}

/** A Codex thread held at its account's limit, its provider session over, nothing attached. */
async function heldThread(
  reset: number | null,
  options: { others?: string[]; policy?: "manual" | "resume_at_reset" } = {},
) {
  const thread = await codexThread(
    clearedThen(reset, 0),
    [{ on: "send", frames: [started, ...turn("B", "completed")] }],
    options.policy ?? "manual",
    options.others ?? [],
  );
  const id = await thread.h.create();
  await thread.h.engine.flush();
  expect(thread.h.engine.queue(id)).toMatchObject({ paused: true, reason: "limit" });
  thread.exitSession();
  await thread.h.engine.flush();
  const codex = fakeCodex(thread.h.clock.now);
  const management = await thread.management(codex.read);
  const home = thread.registry.get("account-a")?.instance.homeDir ?? "";
  return { ...thread, id, codex, management, home };
}

/** One tick of the daemon's limits timer, `limitsRefreshMs` after the last. */
async function tick(held: Awaited<ReturnType<typeof heldThread>>) {
  held.h.clock.advance(limitsRefreshMs);
  await held.management.limits.tick();
  await held.engine().flush();
}

const limited = (held: Awaited<ReturnType<typeof heldThread>>, id: ThreadId) =>
  held.h.store.getThread(id)?.status.state === "limited";

test.each([
  ["no reset", null],
  ["a reset five hours away", 1_000 + 300 * minute],
])(
  "a held thread whose stored limit gives %s is released by the next reading once quota is back",
  async (_name, reset) => {
    const held = await heldThread(reset);
    try {
      // The startup reading, then three ticks still at the limit: read on every tick.
      await held.management.limits.refresh();
      for (let index = 0; index < 3; index++) await tick(held);
      expect(held.codex.reads()).toBe(4);
      expect(limited(held, held.id)).toBe(true);

      held.codex.set(held.home, 3);
      await tick(held);
      expect(limited(held, held.id)).toBe(false);
      expect(held.engine().queue(held.id)).toMatchObject({ paused: true, messages: [] });
      // Released: the person's Resume sends at once.
      expect(
        dispatch(held.h.store, held.engine(), {
          type: "thread.resume",
          threadId: held.id,
          expectedRevision: held.engine().queue(held.id).revision,
        }).ok,
      ).toBe(true);
      await held.engine().flush();
      expect(held.providerSends()).toBe(2);

      // Nothing held, no session, no client: the timer reads no more.
      const reads = held.codex.reads();
      for (let index = 0; index < 3; index++) await tick(held);
      expect(held.codex.reads()).toBe(reads);
    } finally {
      await held.close();
    }
  },
);

test("a held thread whose stored reset has already passed is released once quota is back", async () => {
  const held = await heldThread(500);
  try {
    await held.management.limits.refresh();
    held.codex.set(held.home, 3);
    await tick(held);
    expect(limited(held, held.id)).toBe(false);
  } finally {
    await held.close();
  }
});

test("a thread held across a daemon restart is still read for and released", async () => {
  const held = await heldThread(null);
  try {
    await held.management.limits.refresh();
    await held.restart();
    await tick(held);
    await tick(held);
    expect(held.codex.reads()).toBe(3);
    expect(limited(held, held.id)).toBe(true);
    held.codex.set(held.home, 3);
    await tick(held);
    expect(limited(held, held.id)).toBe(false);
  } finally {
    await held.close();
  }
});

test("with several accounts, the held one's reading releases its thread and the others' do not", async () => {
  const held = await heldThread(null, { others: ["account-b", "account-c"] });
  try {
    const other = held.registry.get("account-b")?.instance.homeDir ?? "";
    held.codex.set(other, 3);
    held.codex.set(held.registry.get("account-c")?.instance.homeDir ?? "", 3);
    await held.management.limits.refresh();
    await tick(held);
    await tick(held);
    // Every account is read while one holds a thread; the free ones release nothing.
    expect(held.codex.readsOf(held.home)).toBe(3);
    expect(held.codex.readsOf(other)).toBe(3);
    expect(limited(held, held.id)).toBe(true);
    held.codex.set(held.home, 3);
    await tick(held);
    expect(limited(held, held.id)).toBe(false);
  } finally {
    await held.close();
  }
});

test("a resume scheduled for a far reset, with no session open, has its limit lifted by the next reading", async () => {
  const reset = 1_000 + 300 * minute;
  const held = await heldThread(reset, { policy: "resume_at_reset" });
  try {
    expect(held.engine().queue(held.id)).toMatchObject({ resumeAt: reset });
    await held.management.limits.refresh();
    await tick(held);
    expect(held.codex.reads()).toBe(2);
    expect(limited(held, held.id)).toBe(true);
    held.codex.set(held.home, 3);
    await tick(held);
    expect(limited(held, held.id)).toBe(false);
    // Nothing waits on a limit any more: the timer stops reading.
    const reads = held.codex.reads();
    await tick(held);
    expect(held.codex.reads()).toBe(reads);
    expect(sends(held.h.adapter)).toHaveLength(1);
  } finally {
    await held.close();
  }
});

test("limits are read on every tick while a turn runs, with nothing held and no client", async () => {
  const thread = await codexThread(
    [
      {
        on: "send",
        frames: [
          started,
          frame({ method: "turn/started", params: { threadId: "native", turn: { id: "A" } } }),
        ],
      },
    ],
    [],
  );
  try {
    await thread.h.create();
    await thread.h.engine.flush();
    const codex = fakeCodex(thread.h.clock.now);
    const management = await thread.management(codex.read);
    for (let index = 0; index < 3; index++) {
      thread.h.clock.advance(limitsRefreshMs);
      await management.limits.tick();
    }
    expect(codex.reads()).toBe(3);
  } finally {
    await thread.close();
  }
});
