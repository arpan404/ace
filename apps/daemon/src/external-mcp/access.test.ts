import { expect, test } from "vitest";
import { AccessRequests } from "./access-requests.ts";
import { OutsideScreen } from "./screen-use.ts";

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
      for (const entry of [...pending]) {
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
  const { request, outcome } = owner.open({ clientName: "Bot", domain: null, scopes: ["browser"] });
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
  // The next call after Stop runs under a fresh signal.
  expect(screen.signal("grant-1", "Claude").aborted).toBe(false);
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
