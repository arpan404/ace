import { expect, test } from "vitest";
import { contact, REMOTE_CHILD_LEASE_MS, renew } from "./lease.ts";
import { holdsParent, standing } from "./standing.ts";
import {
  attempted,
  INTERRUPT_GRACE_MS,
  KILL_GRACE_MS,
  REMOTE_CANCEL_WAITS_MS,
  TERMINATE_GRACE_MS,
  nextStop,
  PROCESS_STOP,
  REMOTE_STOP,
  SIGNAL_STOP,
  startStop,
  stopBound,
  type StopPlan,
  type StopProgress,
} from "./stop.ts";

/** Runs a stop to its end under `plan`, making every attempt it asks for; none is confirmed. */
function runOut<A extends string>(plan: StopPlan<A>, start: number) {
  let progress: StopProgress = startStop(start);
  let now = start;
  const actions: { action: A; at: number }[] = [];
  for (let guard = 0; guard < 20; guard++) {
    const next = nextStop(plan, progress, now);
    if (next.kind === "give_up") return { actions, gaveUpAt: now };
    if (next.kind === "attempt") {
      actions.push({ action: next.action, at: now });
      progress = attempted(progress, now);
    } else now = next.until;
  }
  throw new Error("The stop never ended");
}

test("a hung local process gets interrupt, SIGTERM, then SIGKILL, and is stopped within the bound", () => {
  const { actions, gaveUpAt } = runOut(PROCESS_STOP, 1_000);
  expect(actions.map((entry) => entry.action)).toEqual(["interrupt", "terminate", "kill"]);
  expect(actions[1]?.at).toBe(1_000 + INTERRUPT_GRACE_MS);
  expect(gaveUpAt - 1_000).toBe(stopBound(PROCESS_STOP));
  expect(stopBound(PROCESS_STOP)).toBeLessThanOrEqual(10_000);
});

test("a background shell that ignores SIGTERM is sent SIGKILL after the grace", () => {
  const { actions } = runOut(SIGNAL_STOP, 0);
  expect(actions).toEqual([
    { action: "terminate", at: 0 },
    { action: "kill", at: TERMINATE_GRACE_MS },
  ]);
});

test("a remote cancel that is never confirmed is sent again with growing waits, then given up", () => {
  const { actions, gaveUpAt } = runOut(REMOTE_STOP, 0);
  expect(actions.length).toBe(REMOTE_STOP.length);
  const gaps = actions.slice(1).map((entry, index) => entry.at - (actions[index]?.at ?? 0));
  expect(gaps.every((gap, index) => index === 0 || gap > (gaps[index - 1] ?? 0))).toBe(true);
  expect(gaveUpAt).toBe(stopBound(REMOTE_STOP));
  expect(gaveUpAt).toBeLessThanOrEqual(60_000);
});

test("a stop kept across a restart picks up where it was, and one past its bound gives up at once", () => {
  const [first, second] = REMOTE_CANCEL_WAITS_MS;
  const halfway = attempted(attempted(startStop(0), 0), first);
  // Restarted inside the second wait: it waits out the rest, then sends the third cancel.
  const inside = first + 1_000;
  expect(nextStop(REMOTE_STOP, halfway, inside)).toEqual({ kind: "wait", until: first + second });
  expect(nextStop(REMOTE_STOP, halfway, inside + second)).toMatchObject({
    kind: "attempt",
    step: 2,
  });
  // Every attempt went out before the daemon stopped for an hour: it is stopped at startup.
  let all = startStop(0);
  for (const _ of REMOTE_STOP) all = attempted(all, 0);
  expect(nextStop(REMOTE_STOP, all, 60 * 60_000)).toEqual({ kind: "give_up" });
});

test("a clock that goes back never holds a stop open past one step", () => {
  const once = attempted(startStop(10_000), 10_000);
  expect(nextStop(PROCESS_STOP, once, 5_000)).toMatchObject({ kind: "attempt", step: 1 });
});

test("a remote child that stops reporting is lost contact once its lease lapses, and found when it reports", () => {
  const lease = { renewedAt: 0, ttlMs: REMOTE_CHILD_LEASE_MS };
  expect(contact(lease, REMOTE_CHILD_LEASE_MS - 1).kind).toBe("live");
  expect(contact(lease, REMOTE_CHILD_LEASE_MS)).toEqual({
    kind: "lost",
    since: REMOTE_CHILD_LEASE_MS,
  });
  const reported = renew(lease, REMOTE_CHILD_LEASE_MS + 5);
  expect(contact(reported, REMOTE_CHILD_LEASE_MS + 10).kind).toBe("live");
  // An older proof arriving late never moves the lease back.
  expect(renew(reported, 1)).toBe(reported);
});

test("only live work and a stop inside its bound hold the parent", () => {
  const lease = { renewedAt: 0, ttlMs: 1_000 };
  const live = standing({ ended: false, lease }, 500);
  const lost = standing({ ended: false, lease }, 1_000);
  const ended = standing({ ended: true, lease }, 500);
  const progress = attempted(startStop(0), 0);
  const stopping = standing({ ended: false, lease, stop: { plan: SIGNAL_STOP, progress } }, 100);
  const gaveUp = standing(
    { ended: false, lease, stop: { plan: SIGNAL_STOP, progress: attempted(progress, 3_000) } },
    3_000 + KILL_GRACE_MS,
  );
  expect([live, lost, ended, stopping, gaveUp].map((at) => at.kind)).toEqual([
    "live",
    "lost",
    "ended",
    "stopping",
    "stopped_unconfirmed",
  ]);
  expect([live, lost, ended, stopping, gaveUp].map(holdsParent)).toEqual([
    true,
    false,
    false,
    true,
    false,
  ]);
});

test("a stop gives up on its own bound even while the item still reports", () => {
  const lease = { renewedAt: 1_000_000, ttlMs: REMOTE_CHILD_LEASE_MS };
  let progress = startStop(0);
  for (const _ of REMOTE_STOP) progress = attempted(progress, 0);
  expect(
    standing({ ended: false, lease, stop: { plan: REMOTE_STOP, progress } }, 1_000_000).kind,
  ).toBe("stopped_unconfirmed");
});

test("an item already stopped without confirmation stays stopped when it reports again", () => {
  const lease = { renewedAt: 5, ttlMs: 10 };
  expect(standing({ ended: false, lease, stoppedUnconfirmed: true }, 6).kind).toBe(
    "stopped_unconfirmed",
  );
});
