import { afterEach, expect, it, vi } from "vitest";
import { Device, HostId, ThreadId } from "@ace/protocol";
import { harness, scriptFrames, start } from "../engine/test-support.ts";
import { TargetThreads } from "../machines/target-threads.ts";
import { sessionContainment } from "./containment.ts";
import { BackendUnreachable, memberWork } from "./member-work.ts";
import { memberWorkStore } from "./store.ts";
import { memberStopFailures, stopMemberTree } from "./wire.ts";

/*
 * A member tree's child that another host delegates here (ADR 0209 §7), over a real engine and
 * store. It carries the member and how long it may run, and this machine tears it down by then
 * on its own clock, with no word from the source and nothing able to renew it. A source that
 * lost the answer to its delegation can ask without making a child; once asked, the request is
 * withdrawn here, so a late copy of the original makes nothing either.
 */

const minute = 60_000;
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
const delegate = (requestId: string, extra: Record<string, unknown> = {}) =>
  ({
    op: "delegate",
    requestId,
    task: `Do ${requestId}`,
    role: requestId,
    provider: "codex",
    ...extra,
  }) as const;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function destination() {
  const frames = scriptFrames();
  const h = await harness([], frames);
  await h.engine.ready();
  h.store.atomic((db) =>
    db
      .prepare(
        "INSERT INTO devices (id, name, token_hash, scopes, created_at, last_seen_at, revoked_at, expires_at, install_id) VALUES (?, ?, ?, ?, 1, 1, NULL, NULL, NULL)",
      )
      .run(device.id, device.name, "hash", JSON.stringify(device.scopes)),
  );
  // Members' work on a machine that isn't the organization's host: it still holds the child to
  // its deadline. The source is unreachable throughout.
  const clock = { wall: Date.now(), mono: 0 };
  const work = memberWork({
    store: memberWorkStore(h.store),
    org: () => undefined,
    host: () => undefined,
    fetchRoster: async () => {
      throw new BackendUnreachable("offline");
    },
    keys: () => ({ keys: [] }),
    stopTree: (root, reason) =>
      stopMemberTree({ engine: h.engine, delegations: { cancelMember: () => {} } }, root, reason),
    containment: sessionContainment,
    wall: () => clock.wall,
    monotonic: () => clock.mono,
    delay: () => () => {},
    id: () => "start",
  });
  const threads = new TargetThreads({
    store: h.store,
    engine: () => h.engine,
    journal: () => undefined,
    now: () => h.clock.now(),
    limit: () => undefined,
    schedule: () => () => {},
    report: () => {},
    memberChildren: () => work,
  });
  closers.push(async () => {
    threads.close();
    await work.close();
    await h.close();
  });
  return { h, frames, work, threads, clock };
}

it("a member's child made here is torn down at its own deadline, with no word from its source", async () => {
  const { h, frames, work, threads, clock } = await destination();
  const made = await threads.delegate(
    device,
    origin,
    delegate("mias-child", { member: { account: "user_mia", ttlMs: 10 * minute } }),
  );
  await vi.waitFor(() =>
    expect(h.contexts.some((ctx) => ctx.threadId === made.threadId)).toBe(true),
  );
  h.contexts.find((ctx) => ctx.threadId === made.threadId)?.onFrame(frames.frame(start));
  await h.engine.flush();
  expect(h.store.getThread(made.threadId)?.status.state).toBe("working");

  clock.wall += 10 * minute - 1;
  clock.mono += 10 * minute - 1;
  await work.pass();
  expect(h.store.getThread(made.threadId)?.status.state).toBe("working");
  clock.wall += 1;
  clock.mono += 1;
  await work.pass();
  expect(h.store.getThread(made.threadId)?.status.state).toBe("failed");
  expect(h.store.getThread(made.threadId)?.queue?.lastFailure).toEqual(memberStopFailures.deadline);
  expect(work.childExpired(made.threadId)).toBe(true);
});

it("asking whether a lost delegation made a child makes none, and withdraws the request", async () => {
  const { threads } = await destination();
  const made = await threads.delegate(device, origin, delegate("one"));
  // Asked about a request that made a child: named.
  expect(await threads.delegate(device, origin, delegate("one", { probe: true }))).toMatchObject({
    threadId: made.threadId,
  });
  // Asked about one that made none: none is made, and it says so for certain.
  await expect(
    threads.delegate(device, origin, delegate("two", { probe: true })),
  ).rejects.toMatchObject({ code: "not_found" });
  // The original, arriving late after that, makes nothing either.
  await expect(threads.delegate(device, origin, delegate("two"))).rejects.toMatchObject({
    code: "unavailable",
  });
});
