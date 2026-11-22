import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { grantPublicKey, policyBodySha256, signOrgPolicy, signOrgRoster } from "@ace/account-grant";
import type { AceOrgRoster } from "@ace/protocol/ace-org";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { Containment } from "./containment.ts";
import {
  BackendUnreachable,
  memberWork,
  type MemberWorkOptions,
  type TreeStop,
} from "./member-work.ts";
import { memberWorkTimes, offlineAllowanceMs } from "./rules.ts";
import { memberWorkStore } from "./store.ts";

/*
 * Members' work on an org host (ADR 0209 §7) through its public surface: rosters taken or
 * refused, leases renewed or run out, revocations kept across restarts and restores, stops
 * retried until confirmed, and what that does to the member's trees and contained processes.
 * The trees and processes are stand-ins at the boundary; storage is a real SQLite file.
 */

const org = "org_01ACME";
const host = "A".repeat(52);
const key = { id: "k1", privateKey: new Uint8Array(32).fill(9) };
const keys = { keys: [grantPublicKey(key)] };
const minute = 60_000;
const start = Date.parse("2026-11-21T12:00:00.000Z");
const iso = (at: number) => new Date(at).toISOString();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A real SQLite file, reopened by each `open` as a restarted daemon reopens its store. */
function database() {
  const dir = mkdtempSync(join(tmpdir(), "ace-member-work-"));
  dirs.push(dir);
  const path = join(dir, "store.sqlite");
  return () => {
    const db = new DatabaseSync(path);
    return {
      atomic<T>(run: (db: DatabaseSync) => T): T {
        db.exec("BEGIN");
        try {
          const result = run(db);
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    };
  };
}

type Member = { status: string; changed?: number };

/** A roster the backend signed, as the route serves it. */
function roster(
  version: number,
  at: number,
  members: Record<string, Member | string>,
  options: { epoch?: number; signer?: typeof key; org?: string; host?: string } = {},
): AceOrgRoster {
  const body = JSON.stringify({
    members: Object.entries(members).map(([account, member]) => {
      const { status, changed } = typeof member === "string" ? { status: member } : member;
      const entry: { account: string; status: string; role: string; changed?: string } = {
        account,
        status,
        role: "member",
      };
      if (changed !== undefined) entry.changed = iso(changed);
      return entry;
    }),
    hosts: [{ id: options.host ?? host }],
  });
  return {
    body,
    statement: signOrgRoster(
      {
        org: options.org ?? org,
        host: options.host ?? host,
        epoch: options.epoch ?? 1,
        version,
        at,
        body_sha256: policyBodySha256(body),
      },
      options.signer ?? key,
    ),
  };
}

/** Running trees and contained processes, as the daemon's engine and containment hold them. */
function world() {
  const trees = new Map<string, "working" | "failed" | "done">();
  /** Each tree's contained processes, by root. */
  const processes = new Set<string>();
  const faults = { stop: 0, kill: 0, unkillable: new Set<string>() };
  /** What stopping a tree comes to beyond its local sessions, by root. */
  const remote = new Map<string, TreeStop>();
  const hanging = new Set<string>();
  const containment: Containment = {
    kind: "cgroup",
    launchEnv: (account, root) => ({ slice: `${account}/${root}` }),
    async kill(_account, root) {
      if (faults.unkillable.has(root)) return false;
      if (faults.kill > 0) {
        faults.kill--;
        return false;
      }
      processes.delete(root);
      return true;
    },
  };
  return {
    trees,
    processes,
    faults,
    remote,
    hanging,
    containment,
    stopTree: async (root: string): Promise<TreeStop> => {
      if (faults.stop > 0) {
        faults.stop--;
        throw new Error("The engine didn't stop it");
      }
      if (hanging.has(root)) return new Promise<TreeStop>(() => {});
      const was = trees.get(root);
      if (was === "working") trees.set(root, "failed");
      return remote.get(root) ?? (was === "working" ? "stopped" : "idle");
    },
  };
}

/** The host's clocks: wall and monotonic move together unless a test steps the wall. */
type Clock = { wall: number; mono: number };
const advance = (clock: Clock, ms: number) => {
  clock.wall += ms;
  clock.mono += ms;
};

function onHost(
  open: ReturnType<typeof database>,
  w: ReturnType<typeof world>,
  overrides: Partial<MemberWorkOptions> & { clock?: Clock; answer?: () => AceOrgRoster } = {},
) {
  const clock = overrides.clock ?? { wall: start, mono: 0 };
  const fetched: string[] = [];
  const work = memberWork({
    store: memberWorkStore(open()),
    org: () => org,
    host: () => host,
    fetchRoster: async (forOrg) => {
      fetched.push(forOrg);
      if (overrides.answer) return overrides.answer();
      throw new BackendUnreachable("offline");
    },
    keys: () => keys,
    stopTree: w.stopTree,
    containment: w.containment,
    wall: () => clock.wall,
    monotonic: () => clock.mono,
    delay: () => () => {},
    id: (() => {
      let next = 0;
      return () => `start-${++next}`;
    })(),
    ...overrides,
  });
  return { work, clock, fetched };
}

/** Mia's tree, running with its lease held. */
function running(w: ReturnType<typeof world>, work: ReturnType<typeof memberWork>, root = "t_mia") {
  expect(work.admit("user_mia", root)).toBe(true);
  w.trees.set(root, "working");
  w.processes.add(root);
}

it("a lower roster version is refused, so a removed member stays revoked and stopped", async () => {
  const w = world();
  const { work, clock } = onHost(database(), w);
  expect(work.takeRoster(roster(2, clock.wall, { user_mia: "active" }))).toBe("taken");
  running(w, work);

  advance(clock, minute);
  expect(work.takeRoster(roster(3, clock.wall, {}))).toBe("taken");
  await work.pass();
  expect(w.trees.get("t_mia")).toBe("failed");
  expect(w.processes.has("t_mia")).toBe(false);
  expect(work.stopReason("t_mia")).toBe("revoked");

  // The old roster that still listed Mia active, even signed again later, brings nobody back.
  advance(clock, minute);
  expect(work.takeRoster(roster(2, clock.wall, { user_mia: "active" }))).toBe("refused");
  expect(work.revoked("user_mia")).toBe(true);
  expect(work.active("user_mia")).toBe(false);
  expect(work.admit("user_mia", "t_mia")).toBe(false);
  expect(work.resume("user_mia", "t_mia")).toBe(false);
  // The same version signed later only refreshes it; signed earlier, it is refused.
  expect(work.takeRoster(roster(3, clock.wall, {}))).toBe("refreshed");
  expect(work.takeRoster(roster(3, clock.wall - 5 * minute, {}))).toBe("refused");
});

it("the same version with another body is refused, however late it was signed", () => {
  const { work, clock } = onHost(database(), world());
  expect(work.takeRoster(roster(4, clock.wall, { user_mia: "removed" }))).toBe("taken");
  advance(clock, minute);
  expect(work.takeRoster(roster(4, clock.wall, { user_mia: "active" }))).toBe("refused");
  expect(work.revoked("user_mia")).toBe(true);
});

it("a restored backend's new epoch can't lift a revocation with a state older than the removal", () => {
  const { work, clock } = onHost(database(), world());
  const joined = start - 60 * minute;
  const removed = start - 10 * minute;
  work.takeRoster(roster(5, clock.wall, { user_mia: { status: "active", changed: joined } }));
  work.takeRoster(roster(6, clock.wall, { user_mia: { status: "removed", changed: removed } }));
  expect(work.revoked("user_mia")).toBe(true);
  // Restored from a backup taken before the removal: a new series, showing her active as then.
  advance(clock, minute);
  const restored = { user_mia: { status: "active", changed: joined } };
  expect(work.takeRoster(roster(1, clock.wall, restored, { epoch: 2 }))).toBe("taken");
  expect(work.revoked("user_mia")).toBe(true);
  expect(work.active("user_mia")).toBe(false);
  // The old series can't come back after it.
  expect(work.takeRoster(roster(7, clock.wall, restored))).toBe("refused");
  // Only WorkOS adding her again, after the removal, lifts it.
  const rejoined = { user_mia: { status: "active", changed: start } };
  expect(work.takeRoster(roster(2, clock.wall, rejoined, { epoch: 2 }))).toBe("taken");
  expect(work.revoked("user_mia")).toBe(false);
  expect(work.active("user_mia")).toBe(true);
});

it("a roster for another host or organization, or not signed by the backend, is refused", () => {
  const { work, clock } = onHost(database(), world());
  const other = { id: "k1", privateKey: new Uint8Array(32).fill(3) };
  const mia = { user_mia: "active" };
  expect(work.takeRoster(roster(1, clock.wall, mia, { host: "B".repeat(52) }))).toBe("refused");
  expect(work.takeRoster(roster(1, clock.wall, mia, { org: "org_01OTHER" }))).toBe("refused");
  expect(work.takeRoster(roster(1, clock.wall, mia, { signer: other }))).toBe("refused");
  const forged = roster(1, clock.wall, mia);
  expect(work.takeRoster({ ...forged, body: forged.body.replace("member", "owner") })).toBe(
    "refused",
  );
  expect(work.active("user_mia")).toBe(false);
});

it("an unreachable backend leaves a member's work running for the allowance plus a lease, then stops it", async () => {
  const w = world();
  const { work, clock } = onHost(database(), w);
  expect(work.takeRoster(roster(1, start, { user_mia: "active" }))).toBe("taken");
  const body = JSON.stringify({ threads: { offline_minutes: 10 } });
  work.policySeen({
    org,
    version: 4,
    body,
    statement: signOrgPolicy(
      { org, version: 4, body_sha256: policyBodySha256(body), set_by: "user_owner", set_at: 1 },
      key,
    ),
  });
  running(w, work);

  // Every fetch gets no answer from here. At the allowance's edge the roster still renews.
  advance(clock, 10 * minute);
  await work.sync();
  expect(work.active("user_mia")).toBe(true);
  // Past it nothing renews, but the lease runs its fifteen minutes.
  advance(clock, minute);
  await work.sync();
  expect(work.active("user_mia")).toBe(false);
  advance(clock, 13 * minute);
  await work.sync();
  expect(w.trees.get("t_mia")).toBe("working");
  advance(clock, minute);
  await work.sync();
  expect(w.trees.get("t_mia")).toBe("failed");
  expect(work.stopReason("t_mia")).toBe("lease_expired");
  // Back with Mia still active: no engine continuation, retry, automation or unproven send
  // takes the tree back; only her own proven input resumes it.
  expect(work.takeRoster(roster(1, clock.wall, { user_mia: "active" }))).toBe("refreshed");
  expect(work.admit("user_mia", "t_mia")).toBe(false);
  expect(work.resume("user_mia", "t_mia")).toBe(true);
  expect(work.stopReason("t_mia")).toBeUndefined();
  expect(work.admit("user_mia", "t_mia")).toBe(true);
});

it("without a policy the allowance is sixty minutes", async () => {
  const w = world();
  const { work, clock } = onHost(database(), w);
  work.takeRoster(roster(1, start, { user_mia: "active" }));
  running(w, work);
  for (let passed = 0; passed < 74; passed += 2) {
    advance(clock, 2 * minute);
    await work.sync();
  }
  expect(w.trees.get("t_mia")).toBe("working");
  advance(clock, 2 * minute);
  await work.sync();
  expect(w.trees.get("t_mia")).toBe("failed");
});

it("a backend that answers but refuses this host gives no offline allowance", async () => {
  const w = world();
  const fresh = roster(1, start, { user_mia: "active" });
  let answer = (): AceOrgRoster => fresh;
  const { work, clock } = onHost(database(), w, { answer: () => answer() });
  await work.sync();
  running(w, work);
  // From here it answers 401, as for a credential it no longer takes.
  answer = () => {
    throw new Error("The organization's roster was refused (401).");
  };
  advance(clock, 3 * minute);
  await work.sync();
  expect(work.active("user_mia")).toBe(false);
  advance(clock, 12 * minute);
  await work.sync();
  expect(w.trees.get("t_mia")).toBe("failed");
});

it("a wall clock stepped backwards buys nobody time", async () => {
  const w = world();
  const { work, clock } = onHost(database(), w);
  work.takeRoster(roster(1, start, { user_mia: "active" }));
  work.policySeen({
    org,
    version: 1,
    body: '{"threads":{"offline_minutes":0}}',
    statement: signOrgPolicy(
      {
        org,
        version: 1,
        body_sha256: policyBodySha256('{"threads":{"offline_minutes":0}}'),
        set_by: "user_owner",
        set_at: 1,
      },
      key,
    ),
  });
  running(w, work);
  advance(clock, 3 * minute);
  await work.sync();
  // The wall clock goes back an hour; the monotonic clock keeps going.
  clock.wall -= 60 * minute;
  expect(work.active("user_mia")).toBe(false);
  clock.mono += 12 * minute;
  await work.sync();
  expect(w.trees.get("t_mia")).toBe("failed");
});

it("a host restarted with its clock behind its last pass renews nothing on the roster from before", async () => {
  const open = database();
  const before = world();
  const first = onHost(open, before);
  first.work.takeRoster(roster(1, start, { user_mia: "active" }));
  running(before, first.work);
  advance(first.clock, 5 * minute);
  await first.work.pass();
  await first.work.close();

  // Back up with the wall clock behind the last pass: how long it was down is unknown.
  const after = world();
  after.trees.set("t_mia", "working");
  const restarted = onHost(open, after, { clock: { wall: start + minute, mono: 0 } });
  await restarted.work.start();
  expect(restarted.work.active("user_mia")).toBe(false);
  restarted.clock.mono += 15 * minute;
  await restarted.work.sync();
  expect(after.trees.get("t_mia")).toBe("failed");
});

it("a lease that ran out is stopped, never renewed, even by a fresh roster", async () => {
  const w = world();
  const fresh = { current: roster(1, start, { user_mia: "active" }) };
  const { work, clock } = onHost(database(), w, { answer: () => fresh.current });
  await work.sync();
  running(w, work);
  // The host slept through every pass; it wakes to a fresh roster with Mia active.
  advance(clock, 20 * minute);
  fresh.current = roster(1, clock.wall, { user_mia: "active" });
  expect(work.admit("user_mia", "t_mia")).toBe(false);
  await work.sync();
  expect(w.trees.get("t_mia")).toBe("failed");
  expect(work.stopReason("t_mia")).toBe("lease_expired");
});

it("a stop that fails is retried, after a restart too, until its tree and processes are confirmed gone", async () => {
  const open = database();
  const w = world();
  const first = onHost(open, w);
  first.work.takeRoster(roster(1, start, { user_mia: "active" }));
  running(w, first.work);
  advance(first.clock, minute);
  first.work.takeRoster(roster(2, first.clock.wall, {}));
  // The engine fails the first stop and the processes outlive the kill: the stop stays pending.
  w.faults.stop = 1;
  w.faults.kill = 1;
  await first.work.pass();
  expect(w.trees.get("t_mia")).toBe("working");
  expect(w.processes.has("t_mia")).toBe(true);
  expect(first.work.pendingStops()).toEqual(["t_mia"]);
  expect(first.work.resume("user_mia", "t_mia")).toBe(false);
  // The next pass stops the tree, but the processes outlive the kill: still pending.
  w.faults.kill = 1;
  await first.work.pass();
  expect(w.trees.get("t_mia")).toBe("failed");
  expect(w.processes.has("t_mia")).toBe(true);
  expect(first.work.pendingStops()).toEqual(["t_mia"]);
  await first.work.close();

  // After a restart, offline, the first pass finishes it.
  const restarted = onHost(open, w, { clock: { wall: first.clock.wall, mono: 0 } });
  await restarted.work.start();
  expect(w.processes.has("t_mia")).toBe(false);
  expect(restarted.work.pendingStops()).toEqual([]);
  expect(restarted.work.stopReason("t_mia")).toBe("revoked");
});

it("a revocation seen before a restart stops the member's work at the restarted host's first pass, offline", async () => {
  const open = database();
  const first = onHost(open, world());
  first.work.takeRoster(roster(1, start, { user_mia: "active", user_ben: "active" }));
  first.work.admit("user_mia", "t_mia");
  first.work.admit("user_ben", "t_ben");
  // The roster that removes Mia lands, and the daemon dies before any pass runs.
  first.work.takeRoster(roster(2, start, { user_ben: "active" }));

  const after = world();
  after.trees.set("t_mia", "working");
  after.trees.set("t_ben", "working");
  const restarted = onHost(open, after, { clock: { wall: start + minute, mono: 0 } });
  await restarted.work.start();
  expect(restarted.fetched).toEqual([org]);
  expect(after.trees.get("t_mia")).toBe("failed");
  expect(after.trees.get("t_ben")).toBe("working");
  expect(restarted.work.revoked("user_mia")).toBe(true);
  await restarted.work.close();
});

it("stopping a member's work stops each of their trees and kills their contained processes only", async () => {
  const w = world();
  const { work, clock } = onHost(database(), w);
  work.takeRoster(roster(1, clock.wall, { user_mia: "active", user_ben: "active" }));
  for (const [account, root] of [
    ["user_mia", "t_mia_1"],
    ["user_mia", "t_mia_2"],
    ["user_ben", "t_ben"],
  ] as const) {
    work.admit(account, root);
    w.trees.set(root, "working");
    w.processes.add(root);
  }
  await work.stop("user_mia");
  expect(Object.fromEntries(w.trees)).toEqual({
    t_mia_1: "failed",
    t_mia_2: "failed",
    t_ben: "working",
  });
  expect([...w.processes]).toEqual(["t_ben"]);
});

it("on a personal machine no roster is asked for and no work is admitted, contained or stopped", async () => {
  const w = world();
  const { work, clock, fetched } = onHost(database(), w, { org: () => undefined });
  w.trees.set("t_mine", "working");
  w.processes.add("t_mine");
  await work.start();
  expect(work.admit("user_pat", "t_mine")).toBe(false);
  expect(work.remoteStart("user_pat", "t_mine")).toBeUndefined();
  advance(clock, 24 * 60 * minute);
  await work.sync();
  await work.stop("user_pat");
  expect(fetched).toEqual([]);
  expect(w.trees.get("t_mine")).toBe("working");
  expect(w.processes.has("t_mine")).toBe(true);
  expect(work.active("user_pat")).toBe(false);
  await work.close();
});

it("a stop stays pending until every child on another host is confirmed ended, or its lease there must have run out", async () => {
  const w = world();
  const { work, clock } = onHost(database(), w);
  work.takeRoster(roster(1, clock.wall, { user_mia: "active" }));
  running(w, work);
  w.remote.set("t_mia", "remote_pending");
  advance(clock, minute);
  work.takeRoster(roster(2, clock.wall, {}));
  await work.pass();
  expect(w.trees.get("t_mia")).toBe("failed");
  expect(work.pendingStops()).toEqual(["t_mia"]);
  // The destination confirms: the stop is done.
  w.remote.set("t_mia", "stopped");
  await work.pass();
  expect(work.pendingStops()).toEqual([]);
});

it("a remote child whose end is never confirmed holds the stop until its own lease must have ended it", async () => {
  const w = world();
  const { work, clock } = onHost(database(), w);
  work.takeRoster(roster(1, clock.wall, { user_mia: "active" }));
  running(w, work);
  w.remote.set("t_mia", "remote_pending");
  work.takeRoster(roster(2, clock.wall, {}));
  await work.pass();
  advance(clock, offlineAllowanceMs(undefined) + memberWorkTimes.leaseMs - minute);
  await work.pass();
  expect(work.pendingStops()).toEqual(["t_mia"]);
  advance(clock, minute);
  await work.pass();
  expect(work.pendingStops()).toEqual([]);
});

it("a delegation still on its way holds the stop, and the child it lands is to be stopped", async () => {
  const w = world();
  const { work, clock } = onHost(database(), w);
  work.takeRoster(roster(1, clock.wall, { user_mia: "active" }));
  running(w, work);
  const flight = work.remoteStart("user_mia", "t_mia");
  if (!flight) throw new Error("Refused");
  work.takeRoster(roster(2, clock.wall, {}));
  await work.pass();
  expect(work.pendingStops()).toEqual(["t_mia"]);
  // Its answer lands after the stop: the caller is told to stop the child there.
  expect(flight.settle("t_remote_child")).toBe(true);
  await work.pass();
  expect(work.pendingStops()).toEqual([]);
  // A delegation of a stopped tree isn't even recorded.
  expect(work.remoteStart("user_mia", "t_mia")).toBeUndefined();
});

it("each tree's containment is killed and confirmed on its own", async () => {
  const w = world();
  const { work, clock } = onHost(database(), w);
  work.takeRoster(roster(1, clock.wall, { user_mia: "active" }));
  running(w, work, "t_one");
  running(w, work, "t_two");
  // The first tree's cgroup can't be confirmed empty; the second's can.
  w.faults.unkillable.add("t_one");
  work.takeRoster(roster(2, clock.wall, {}));
  await work.pass();
  expect(work.pendingStops()).toEqual(["t_one"]);
  expect([...w.processes]).toEqual(["t_one"]);
  w.faults.unkillable.clear();
  await work.pass();
  expect(work.pendingStops()).toEqual([]);
  expect(w.processes.size).toBe(0);
});

it("one tree whose teardown hangs holds back neither the others nor the pass", async () => {
  const w = world();
  const { work, clock } = onHost(database(), w, {
    stopBoundMs: 20,
    delay: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
  });
  work.takeRoster(roster(1, clock.wall, { user_mia: "active" }));
  running(w, work, "t_stuck");
  running(w, work, "t_free");
  w.hanging.add("t_stuck");
  work.takeRoster(roster(2, clock.wall, {}));
  await work.pass();
  expect(w.trees.get("t_free")).toBe("failed");
  expect(work.pendingStops()).toEqual(["t_stuck"]);
});
