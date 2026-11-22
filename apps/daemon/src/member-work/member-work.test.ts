import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { grantPublicKey, policyBodySha256, signOrgPolicy, signOrgRoster } from "@ace/account-grant";
import type { AceOrgRoster } from "@ace/protocol/ace-org";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { Containment } from "./containment.ts";
import { memberWork, type MemberWorkOptions } from "./member-work.ts";
import { memberWorkStore } from "./store.ts";

/*
 * Members' work on an org host (ADR 0209 §7) through its public surface: rosters taken or
 * refused, leases renewed or run out, revocations kept across a restart, and what that does to
 * the member's trees and contained processes. The trees and processes are stand-ins at the
 * boundary; storage is a real SQLite file.
 */

const org = "org_01ACME";
const host = "A".repeat(52);
const key = { id: "k1", privateKey: new Uint8Array(32).fill(9) };
const keys = { keys: [grantPublicKey(key)] };
const minute = 60_000;

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
      db,
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

/** A roster the backend signed for `forHost` in `forOrg`, as the route serves it. */
function roster(
  version: number,
  at: number,
  members: Record<string, string>,
  signer = key,
  forOrg = org,
  forHost = host,
): AceOrgRoster {
  const body = JSON.stringify({
    members: Object.entries(members).map(([account, status]) => ({
      account,
      status,
      role: "member",
    })),
    hosts: [{ id: forHost }],
  });
  return {
    body,
    statement: signOrgRoster(
      { org: forOrg, host: forHost, version, at, body_sha256: policyBodySha256(body) },
      signer,
    ),
  };
}

/** Running trees and contained processes, as the daemon's engine and containment hold them. */
function world() {
  const trees = new Map<string, "working" | "interrupted" | "done">();
  const processes = new Map<string, number>();
  const containment: Containment = {
    kind: "process-group",
    async contain(account) {
      processes.set(account, (processes.get(account) ?? 0) + 1);
      return true;
    },
    async kill(account) {
      processes.delete(account);
    },
  };
  return {
    trees,
    processes,
    containment,
    stopTree: async (root: string) => {
      if (trees.get(root) !== "working") return false;
      trees.set(root, "interrupted");
      return true;
    },
  };
}

function onHost(
  open: ReturnType<typeof database>,
  w: ReturnType<typeof world>,
  overrides: Partial<MemberWorkOptions> & { clock?: { now: number } } = {},
) {
  const clock = overrides.clock ?? { now: 1_000_000 };
  const fetched: string[] = [];
  const work = memberWork({
    store: memberWorkStore(open()),
    org: () => org,
    host: () => host,
    fetchRoster: async (forOrg) => {
      fetched.push(forOrg);
      throw new Error("offline");
    },
    keys: () => keys,
    stopTree: w.stopTree,
    containment: w.containment,
    now: () => clock.now,
    delay: () => () => {},
    ...overrides,
  });
  return { work, clock, fetched };
}

it("a lower roster version is refused, so a removed member stays revoked and stopped", async () => {
  const w = world();
  const { work, clock } = onHost(database(), w);
  expect(work.takeRoster(roster(2, clock.now, { user_mia: "active" }))).toBe("taken");
  expect(work.hold("user_mia", "t_mia")).toBe(true);
  w.trees.set("t_mia", "working");
  await work.contain("user_mia", 4242);

  clock.now += minute;
  expect(work.takeRoster(roster(3, clock.now, {}))).toBe("taken");
  await work.pass();
  expect(w.trees.get("t_mia")).toBe("interrupted");
  expect(w.processes.has("user_mia")).toBe(false);
  expect(work.stopReason("t_mia")).toBe("revoked");

  // The old roster that still listed Mia active, even signed again later, brings nobody back.
  clock.now += minute;
  expect(work.takeRoster(roster(2, clock.now, { user_mia: "active" }))).toBe("refused");
  expect(work.revoked("user_mia")).toBe(true);
  expect(work.active("user_mia")).toBe(false);
  expect(work.hold("user_mia", "t_mia")).toBe(false);
  // The same version signed later only refreshes it.
  expect(work.takeRoster(roster(3, clock.now, {}))).toBe("refreshed");
  expect(work.takeRoster(roster(3, clock.now - 5 * minute, {}))).toBe("refused");
});

it("a roster for another host or organization, or not signed by the backend, is refused", () => {
  const { work, clock } = onHost(database(), world());
  const other = { id: "k1", privateKey: new Uint8Array(32).fill(3) };
  const mia = { user_mia: "active" };
  expect(work.takeRoster(roster(1, clock.now, mia, key, org, "B".repeat(52)))).toBe("refused");
  expect(work.takeRoster(roster(1, clock.now, mia, key, "org_01OTHER"))).toBe("refused");
  expect(work.takeRoster(roster(1, clock.now, mia, other))).toBe("refused");
  const forged = roster(1, clock.now, mia);
  expect(work.takeRoster({ ...forged, body: forged.body.replace("member", "owner") })).toBe(
    "refused",
  );
  expect(work.active("user_mia")).toBe(false);
});

it("an offline host keeps a member's work for the policy's allowance plus a lease, then stops it", async () => {
  const w = world();
  const { work, clock } = onHost(database(), w);
  const start = clock.now;
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
  expect(work.hold("user_mia", "t_mia")).toBe(true);
  w.trees.set("t_mia", "working");

  // Every fetch fails from here. At the allowance's edge the roster still renews the lease.
  clock.now = start + 10 * minute;
  await work.sync();
  expect(work.active("user_mia")).toBe(true);
  // Past it nothing renews, but the lease runs its fifteen minutes.
  clock.now = start + 11 * minute;
  await work.sync();
  expect(work.active("user_mia")).toBe(false);
  clock.now = start + 24 * minute;
  await work.sync();
  expect(w.trees.get("t_mia")).toBe("working");
  clock.now = start + 25 * minute;
  await work.sync();
  expect(w.trees.get("t_mia")).toBe("interrupted");
  expect(work.stopReason("t_mia")).toBe("lease_expired");
  // Back online with Mia still active: the stopped tree waits for her to resume it.
  expect(work.takeRoster(roster(1, clock.now, { user_mia: "active" }))).toBe("refreshed");
  await work.pass();
  expect(w.trees.get("t_mia")).toBe("interrupted");
  expect(work.hold("user_mia", "t_mia")).toBe(true);
  expect(work.stopReason("t_mia")).toBeUndefined();
});

it("without a policy the allowance is sixty minutes", async () => {
  const w = world();
  const { work, clock } = onHost(database(), w);
  const start = clock.now;
  work.takeRoster(roster(1, start, { user_mia: "active" }));
  work.hold("user_mia", "t_mia");
  w.trees.set("t_mia", "working");
  clock.now = start + 60 * minute;
  await work.sync();
  clock.now = start + 74 * minute;
  await work.sync();
  expect(w.trees.get("t_mia")).toBe("working");
  clock.now = start + 75 * minute;
  await work.sync();
  expect(w.trees.get("t_mia")).toBe("interrupted");
});

it("a revocation seen before a restart stops the member's work at the restarted host's first pass, offline", async () => {
  const open = database();
  const before = world();
  const first = onHost(open, before);
  first.work.takeRoster(roster(1, first.clock.now, { user_mia: "active", user_ben: "active" }));
  first.work.hold("user_mia", "t_mia");
  first.work.hold("user_ben", "t_ben");
  // The roster that removes Mia lands, and the daemon dies before any pass runs.
  first.work.takeRoster(roster(2, first.clock.now, { user_ben: "active" }));

  const after = world();
  after.trees.set("t_mia", "working");
  after.trees.set("t_ben", "working");
  const restarted = onHost(open, after, { clock: { now: first.clock.now + minute } });
  await restarted.work.start();
  expect(restarted.fetched).toEqual([org]);
  expect(after.trees.get("t_mia")).toBe("interrupted");
  expect(after.trees.get("t_ben")).toBe("working");
  expect(restarted.work.revoked("user_mia")).toBe(true);
  expect(restarted.work.takeRoster(roster(1, restarted.clock.now, { user_mia: "active" }))).toBe(
    "refused",
  );
  // Only a later roster that shows her active lifts it.
  expect(restarted.work.takeRoster(roster(3, restarted.clock.now, { user_mia: "active" }))).toBe(
    "taken",
  );
  expect(restarted.work.revoked("user_mia")).toBe(false);
  await restarted.work.close();
});

it("stopping a member's work stops each of their trees and kills their contained processes only", async () => {
  const w = world();
  const { work, clock } = onHost(database(), w);
  work.takeRoster(roster(1, clock.now, { user_mia: "active", user_ben: "active" }));
  for (const [account, root] of [
    ["user_mia", "t_mia_1"],
    ["user_mia", "t_mia_2"],
    ["user_ben", "t_ben"],
  ] as const) {
    work.hold(account, root);
    w.trees.set(root, "working");
    await work.contain(account, 1);
  }
  await work.stop("user_mia");
  expect(Object.fromEntries(w.trees)).toEqual({
    t_mia_1: "interrupted",
    t_mia_2: "interrupted",
    t_ben: "working",
  });
  expect([...w.processes.keys()]).toEqual(["user_ben"]);
});

it("on a personal machine no roster is asked for and no work is held, contained or stopped", async () => {
  const w = world();
  const { work, clock, fetched } = onHost(database(), w, { org: () => undefined });
  w.trees.set("t_mine", "working");
  await work.start();
  expect(work.hold("user_pat", "t_mine")).toBe(false);
  expect(await work.contain("user_pat", 7)).toBe(false);
  clock.now += 24 * 60 * minute;
  await work.sync();
  await work.stop("user_pat");
  expect(fetched).toEqual([]);
  expect(w.trees.get("t_mine")).toBe("working");
  expect(w.processes.size).toBe(0);
  expect(work.active("user_pat")).toBe(false);
  await work.close();
});
