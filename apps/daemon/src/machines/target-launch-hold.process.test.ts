import { afterEach, expect, it } from "vitest";
import { Device, HostId, ThreadId } from "@ace/protocol";
import { harness, scriptFrames } from "../engine/test-support.ts";
import { TargetThreads } from "./target-threads.ts";

/*
 * A child another machine delegates here, while this machine holds new work (a pause, or a disk
 * too full for it, ADR 0174), over a real engine and store. The retry timer is driven by hand.
 */

const device = Device.parse({
  id: "laptop-device",
  name: "Laptop",
  scopes: ["read", "operate"],
  createdAt: 1,
  lastSeenAt: 1,
  revokedAt: null,
});
const origin = {
  hostId: HostId.parse("laptop"),
  hostName: "Laptop",
  threadId: ThreadId.parse("plan"),
  threadTitle: "Plan the release",
};
const delegate = (name: string) =>
  ({
    op: "delegate",
    requestId: name,
    task: `Do ${name}`,
    role: name,
    provider: "codex",
  }) as const;
const closers: (() => Promise<void>)[] = [];
/** The launch queue hears the engine is ready on its first pump, a turn later. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function setup() {
  const h = await harness([], scriptFrames());
  await h.engine.ready();
  // The calling machine's paired device, as pairing records it.
  h.store.atomic((db) =>
    db
      .prepare(
        "INSERT INTO devices (id, name, token_hash, scopes, created_at, last_seen_at, revoked_at, expires_at, install_id) VALUES (?, ?, ?, ?, 1, 1, NULL, NULL, NULL)",
      )
      .run(device.id, device.name, "hash", JSON.stringify(device.scopes)),
  );
  const timers: { ms: number; run: () => void }[] = [];
  const reported: unknown[] = [];
  const machine = { admits: true, storageFull: false };
  const threads = new TargetThreads({
    store: h.store,
    engine: () => h.engine,
    journal: () => undefined,
    now: () => h.clock.now(),
    limit: () => undefined,
    schedule: (ms, run) => {
      const timer = { ms, run };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    report: (error) => reported.push(error),
    admitsWork: () => machine.admits,
    storageFull: () => machine.storageFull,
  });
  closers.push(async () => {
    threads.close();
    await h.close();
  });
  /** Fire the one pending retry, as its timer would; the delay it waited. */
  const tick = () => {
    const timer = timers.shift();
    if (!timer) throw new Error("No retry scheduled");
    timer.run();
    return timer.ms;
  };
  // The disk boundary: the store's file may not grow, and the slack left in it is filled.
  const disk = h.store.atomic((db) => db);
  disk.exec("CREATE TABLE IF NOT EXISTS filler (x BLOB)");
  const fill = () => {
    disk.exec(
      `PRAGMA max_page_count=${Number(disk.prepare("PRAGMA page_count").get()?.page_count)}`,
    );
    try {
      for (;;) disk.prepare("INSERT INTO filler VALUES (randomblob(1024))").run();
    } catch {
      /* Full. */
    }
  };
  const free = () => disk.exec("PRAGMA max_page_count=1073741823");
  return { h, threads, machine, timers, tick, reported, fill, free };
}

it("a child sent here while the disk is full waits queued, says why, backs off, and starts once space is back", async () => {
  const { h, threads, machine, timers, tick } = await setup();
  machine.admits = false;
  machine.storageFull = true;
  const sent = await threads.delegate(device, origin, delegate("held"));
  expect(sent).toMatchObject({ queued: true });
  await settled();
  expect(h.contexts).toHaveLength(0);
  // What the calling machine reads of it.
  expect(threads.view(sent.threadId)).toMatchObject({
    state: "queued",
    step: "Waiting for disk space",
    status: { state: "waiting", on: "queue", waitingFor: "storage" },
  });
  // Each retry that finds the hold still on waits longer, up to a bound; none starts it.
  const delays = Array.from({ length: 8 }, tick);
  expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  expect(h.contexts).toHaveLength(0);

  machine.admits = true;
  machine.storageFull = false;
  // Admission reopening pumps at once (the shell's onReopen); no timer is waited for.
  threads.launches.pump();
  await h.engine.flush();
  expect(h.contexts).toHaveLength(1);
  expect(threads.view(sent.threadId).state).not.toBe("queued");
  expect(timers).toHaveLength(0);
});

it("a waiting child whose start the full disk rolls back is retried on a backoff, then starts", async () => {
  const { h, threads, machine, tick, reported, fill, free } = await setup();
  machine.admits = false;
  const sent = await threads.delegate(device, origin, delegate("rolled-back"));
  expect(sent).toMatchObject({ queued: true });
  await settled();
  fill();
  machine.admits = true;
  threads.launches.pump();
  await settled();
  expect(h.contexts).toHaveLength(0);
  expect(String(reported.at(-1))).toMatch(/full/);
  // Never failed for it: still queued, and each retry waits longer while the disk stays full.
  expect(threads.view(sent.threadId).state).toBe("queued");
  expect([tick(), tick(), tick()]).toEqual([2_000, 4_000, 8_000]);
  expect(threads.view(sent.threadId).state).toBe("queued");

  free();
  tick();
  await h.engine.flush();
  expect(h.contexts).toHaveLength(1);
});

/** What the child was given, in order: input it took, then input queued for its next turn. */
function inputs(h: Awaited<ReturnType<typeof setup>>["h"], threadId: ThreadId): string[] {
  const snapshot = h.store.snapshotThread(threadId);
  const text = (parts: readonly { type: string; text?: string }[]) =>
    parts.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
  const taken = snapshot.itemOrder.flatMap((id) => {
    const item = snapshot.items[id];
    return item?.type === "message" && item.role === "user" ? [text(item.parts)] : [];
  });
  return [...taken, ...h.engine.queue(threadId).messages.map((message) => text(message.input))];
}
const follow = (threadId: ThreadId, requestId: string, delivery: "queue" | "steer" = "queue") =>
  ({ op: "message", threadId, requestId, text: `Follow-up ${requestId}`, delivery }) as const;

it("a parent's messages to a child held for admission start nothing, and reach it once, after its task, when admission reopens", async () => {
  const { h, threads, machine } = await setup();
  machine.admits = false;
  const sent = await threads.delegate(device, origin, delegate("waits"));
  await settled();
  // The parent's message would start a waiting child at once; held, it starts nothing.
  expect(threads.message(device, follow(sent.threadId, "first"))).toEqual({ arrival: "held" });
  expect(threads.message(device, follow(sent.threadId, "second"))).toEqual({ arrival: "held" });
  // A retried copy is the same message.
  expect(threads.message(device, follow(sent.threadId, "first"))).toEqual({ arrival: "held" });
  await h.engine.flush();
  expect(h.contexts).toHaveLength(0);
  expect(threads.launches.queued(sent.threadId)).toBe(true);

  machine.admits = true;
  threads.launches.pump();
  threads.resumeHeld();
  await h.engine.flush();
  expect(h.contexts).toHaveLength(1);
  const got = inputs(h, sent.threadId);
  expect(got.filter((text) => text.includes("Do waits"))).toHaveLength(1);
  expect(got.filter((text) => text.startsWith("Follow-up"))).toEqual([
    "Follow-up first",
    "Follow-up second",
  ]);
  expect(got.findIndex((text) => text.includes("Do waits"))).toBeLessThan(
    got.indexOf("Follow-up first"),
  );
  // Delivered once: another reopen, or a copy arriving late, sends nothing again.
  threads.resumeHeld();
  threads.message(device, follow(sent.threadId, "first"));
  await h.engine.flush();
  expect(inputs(h, sent.threadId).filter((text) => text === "Follow-up first")).toHaveLength(1);
});

it("a message to a running child from another machine is held while admission is closed", async () => {
  const { h, threads, machine } = await setup();
  const sent = await threads.delegate(device, origin, delegate("runs"));
  await h.engine.flush();
  expect(h.contexts).toHaveLength(1);
  machine.admits = false;
  expect(threads.message(device, follow(sent.threadId, "later"))).toEqual({ arrival: "held" });
  await h.engine.flush();
  expect(inputs(h, sent.threadId)).not.toContain("Follow-up later");
  machine.admits = true;
  threads.resumeHeld();
  await h.engine.flush();
  expect(inputs(h, sent.threadId).filter((text) => text === "Follow-up later")).toHaveLength(1);
});
