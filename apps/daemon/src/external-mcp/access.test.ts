import { expect, test } from "vitest";
import { AccessRequests } from "./access-requests.ts";
import { OutsideScreen } from "./screen-use.ts";
import { OutsideAccess } from "./outside.ts";
import { missingScope } from "./scopes.ts";
import { draft, grantDatabase } from "./grant-test-support.ts";

/** A scheduler the test fires by hand. */
function timers() {
  const pending = new Set<{ run: () => void }>();
  return {
    after(_ms: number, run: () => void) {
      const entry = { run };
      pending.add(entry);
      return () => void pending.delete(entry);
    },
    fire() {
      for (const entry of Array.from(pending)) {
        pending.delete(entry);
        entry.run();
      }
    },
  };
}

function requests(now = () => 1_000) {
  const clock = timers();
  let next = 0;
  const owner = new AccessRequests({
    now,
    id: () => `request-${++next}`,
    random: (size) => Buffer.alloc(size, 7),
    after: clock.after,
  });
  return { owner, clock };
}

test("a sign-in request settles with the person's choice and the device that made it", async () => {
  const { owner } = requests();
  const heard: number[] = [];
  owner.subscribe((pending) => heard.push(pending.length));
  const { request, outcome } = owner.open({
    clientName: "Claude",
    domain: "claude.ai",
    scopes: ["threads:read", "threads:start"],
    redirectHost: "claude.ai",
    redirectKind: "web",
  });
  expect(request.matchCode).toMatch(/^[2-9A-Z]{6}$/);
  expect(owner.current()).toEqual([request]);
  expect(
    owner.decide(
      request.requestId,
      { decision: "approve", scopes: ["threads:read"], projects: "all", expiresAt: null },
      "device-9",
    ),
  ).toBe(true);
  await expect(outcome).resolves.toEqual({
    decision: "approve",
    scopes: ["threads:read"],
    projects: "all",
    expiresAt: null,
    by: "device-9",
  });
  expect(owner.current()).toEqual([]);
  expect(heard).toEqual([1, 0]);
  // A second answer finds nothing to decide.
  expect(owner.decide(request.requestId, { decision: "deny" }, "device-9")).toBe(false);
});

test("a sign-in request nobody answers expires and can no longer be approved", async () => {
  let now = 1_000;
  const { owner, clock } = requests(() => now);
  const { request, outcome } = owner.open({
    clientName: "Bot",
    domain: null,
    scopes: ["browser"],
    redirectHost: "localhost:3000",
    redirectKind: "this-device",
  });
  now = request.expiresAt;
  expect(owner.decide(request.requestId, { decision: "deny" }, "device-1")).toBe(false);
  clock.fire();
  await expect(outcome).resolves.toEqual({ decision: "expired" });
  expect(owner.current()).toEqual([]);
});

test("Stop ends an outside client's screen work at once and clears its line", () => {
  const clock = timers();
  const screen = new OutsideScreen(clock.after);
  const heard: unknown[] = [];
  screen.subscribe((uses) => heard.push(uses));
  const signal = screen.signal("grant-1", "Claude");
  screen.begin("grant-1", "Claude", "Safari");
  expect(screen.current()).toEqual([{ grantId: "grant-1", name: "Claude", apps: ["Safari"] }]);
  expect(screen.stop("grant-1")).toBe(true);
  expect(signal.aborted).toBe(true);
  expect(screen.current()).toEqual([]);
  expect(heard.at(-1)).toEqual([]);
});

function outside() {
  const { sql } = grantDatabase();
  const closed: string[] = [];
  const notes: string[] = [];
  let next = 0;
  const access = new OutsideAccess({
    sql,
    now: () => 1_000,
    id: () => `grant-${++next}`,
    scheduler: { after: () => () => {} },
    ended: () => {},
    closeBrowser: (grantId) => closed.push(grantId),
    note: (text) => notes.push(text),
  });
  return { access, closed, notes };
}

test("Stop on the screen line takes computer use out of the grant until the person gives it back", () => {
  const { access, notes } = outside();
  const grant = access.grants.create(draft({ scopes: ["computer", "browser"] }));
  const signal = access.screen.signal(grant.id, grant.name);
  access.screen.begin(grant.id, grant.name, "Safari");
  expect(access.stopScreen(grant.id, "device-7")).toBe(true);
  expect(signal.aborted).toBe(true);
  expect(access.grants.live(grant.id)?.scopes).toEqual(["threads:read", "browser"]);
  // The next screen call is refused: the grant no longer holds the scope.
  expect(missingScope(access.grants.live(grant.id)?.scopes ?? [], "screen_act", {})).toBe(
    "computer",
  );
  expect(notes).toEqual([expect.stringContaining("device-7")]);
});

test("taking browser out of a grant closes its browser session at once", () => {
  const { access, closed } = outside();
  const grant = access.grants.create(draft({ scopes: ["browser"] }));
  access.update(grant.id, { scopes: ["threads:start"] });
  expect(closed).toEqual([grant.id]);
});

test("an app stays on the screen line briefly after its last call, then leaves", () => {
  const clock = timers();
  const screen = new OutsideScreen(clock.after);
  const done = screen.begin("grant-1", "Claude", "Notes");
  done();
  expect(screen.current()).toHaveLength(1);
  clock.fire();
  expect(screen.current()).toEqual([]);
});
