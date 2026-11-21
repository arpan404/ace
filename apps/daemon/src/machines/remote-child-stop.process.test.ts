import { expect, it } from "vitest";
import { REMOTE_CHILD_LEASE_MS } from "../liveness/lease.ts";
import { REMOTE_STOP, stopBound } from "../liveness/stop.ts";
import { ThreadId } from "@ace/protocol";
import { MachineFailure } from "./transport.ts";
import {
  asks,
  children,
  ids,
  live,
  notSent,
  parentView,
  parentWithChildren,
  stopTracking,
} from "./remote-child-test-support.ts";

/*
 * Stop and proof of life for children on paired machines (ADR 0052), with a real parent engine
 * and store and the other machine played in memory. The live case of 2026-11-01: four Codex
 * children whose sessions never opened sat in `needs_you` there ("Not sent · Try again"), their
 * cancels went unanswered, and the parent waited on them for hours.
 */

it("children whose sessions never opened, sitting in needs_you, end stopped after Stop even though their machine never confirms, and the parent stops waiting", async () => {
  const { f, parent, rijan, ledger, at } = await parentWithChildren();
  await at(f.clock.now() + 1_000);
  expect(parentView(f, parent).status.state).toBe("needs_you");

  // The person's Stop: each child's hold is stopped, which stops the child.
  for (const id of ids) expect(ledger.stop(id)).toBe(true);
  const start = f.clock.now();
  await at(start);
  expect(new Set(rijan.cancels)).toEqual(new Set(ids));

  // Rijan keeps reporting them as needing the person; each cancel is sent again with backoff.
  let time = start;
  for (const wait of REMOTE_STOP.map((step) => step.waitMs)) {
    time += wait;
    await at(time);
  }
  expect(rijan.cancels.length).toBe(ids.length * REMOTE_STOP.length);
  expect(time - start).toBe(stopBound(REMOTE_STOP));

  const caller = { sessionId: "s", threadId: parent.threadId, agentId: parent.agentId };
  // agents_status says the cancel is still unconfirmed; a wait reads it cancelled and returns.
  for (const child of ledger.children(caller))
    expect(child).toMatchObject({ state: "cancelling", contact: "unconfirmed" });
  expect(ledger.watched(ids[0] ?? ThreadId.parse("x"))?.view).toMatchObject({
    state: "cancelled",
    result: expect.stringContaining("hasn't confirmed it stopped"),
  });
  const view = parentView(f, parent);
  expect(view.holds.map((hold) => hold.status)).toEqual(ids.map(() => "stopped"));
  expect(view.rows.every((row) => row.kind === "agent" && !row.live)).toBe(true);
  expect(view.rows.map((row) => row.kind === "agent" && row.agent.machine?.contact)).toEqual(
    ids.map(() => "unconfirmed"),
  );
  expect(live).not.toContain(view.status.state);

  // Stopped here, the cancel still goes out about once a minute until Rijan confirms.
  const sent = rijan.cancels.length;
  await at(time + 61_000);
  expect(rijan.cancels.length).toBe(sent + ids.length);
});

it("an unconfirmed cancel keeps going out until the child's machine confirms it ended, then stops and clears the warning", async () => {
  const { f, parent, rijan, ledger, at } = await parentWithChildren(1);
  const [id] = ids;
  if (!id) throw new Error("no child");
  ledger.stop(id);
  await at(f.clock.now() + stopBound(REMOTE_STOP) + 1);
  await at(f.clock.now() + 1);
  const caller = { sessionId: "s", threadId: parent.threadId, agentId: parent.agentId };
  expect(ledger.children(caller)).toEqual([
    expect.objectContaining({ id, state: "cancelling", contact: "unconfirmed" }),
  ]);

  // Rijan stays unreachable for a while: the cancel is still sent, again and again.
  rijan.silent = true;
  const before = rijan.cancels.length;
  for (let minute = 0; minute < 3; minute++) await at(f.clock.now() + 61_000);
  expect(rijan.cancels.length).toBeGreaterThanOrEqual(before + 3);

  // Back, Rijan takes the cancel and reports the child ended.
  rijan.silent = false;
  rijan.onCancel = (cancelled) =>
    rijan.views.set(cancelled, {
      ...notSent(id),
      state: "cancelled",
      status: { state: "done" },
      result: "Stopped.",
      truncated: false,
    });
  for (let poll = 0; poll < 12 && ledger.children(caller)[0]?.state === "cancelling"; poll++)
    await at(f.clock.now() + 61_000);
  expect(ledger.children(caller)).toEqual([expect.objectContaining({ id, state: "cancelled" })]);
  expect(ledger.children(caller)[0]?.contact).toBeUndefined();
  const rows = parentView(f, parent).rows;
  expect(rows.map((row) => row.kind === "agent" && row.agent.machine?.contact)).toEqual([
    undefined,
  ]);

  // Confirmed: no more cancels.
  const confirmed = rijan.cancels.length;
  await at(f.clock.now() + 5 * 61_000);
  expect(rijan.cancels.length).toBe(confirmed);
});

/** Stops the one child and lets every cancel go unconfirmed, so it reads cancelling. */
async function stoppedUnconfirmed() {
  const parts = await parentWithChildren(1);
  const [id] = ids;
  if (!id) throw new Error("no child");
  parts.ledger.stop(id);
  await parts.at(parts.f.clock.now() + stopBound(REMOTE_STOP) + 1);
  await parts.at(parts.f.clock.now() + 1);
  const caller = {
    sessionId: "s",
    threadId: parts.parent.threadId,
    agentId: parts.parent.agentId,
  };
  expect(parts.ledger.children(caller)).toEqual([
    expect.objectContaining({ id, state: "cancelling", contact: "unconfirmed" }),
  ]);
  return { ...parts, id, caller };
}

it("unpairing the machine of a child whose stop is unconfirmed keeps it unconfirmed and asks the person, so the parent never reads done", async () => {
  const { f, parent, rijan, ledger, at, id, caller } = await stoppedUnconfirmed();
  // The parent's own turn ends: only the unconfirmed child could keep it from reading done.
  await f.complete(parent.threadId, "Stopped the review.");
  rijan.paired = false;
  await at(f.clock.now() + 61_000);

  // Still not confirmed stopped: agents_status, a wait and the parent's row all say so.
  expect(ledger.children(caller)).toEqual([
    expect.objectContaining({ id, contact: "unconfirmed" }),
  ]);
  expect(ledger.children(caller)[0]?.step).toContain("no longer paired");
  expect(ledger.watched(id)?.view.contact).toBe("unconfirmed");
  const view = parentView(f, parent);
  expect(view.rows.map((row) => row.kind === "agent" && row.agent.machine?.contact)).toEqual([
    "unconfirmed",
  ]);
  // The parent asks the person instead of reading done.
  const [ask] = asks(f, parent);
  expect(JSON.stringify(ask?.request)).toContain("Lost contact when unpaired");
  expect(view.status.state).toBe("needs_you");
  expect(view.forest.roots[0]?.needsYou).toBe(true);

  // No cancel can reach it while unpaired.
  const sent = rijan.cancels.length;
  await at(f.clock.now() + 5 * 61_000);
  expect(rijan.cancels.length).toBe(sent);
  expect(asks(f, parent)).toHaveLength(1);

  // Paired again: the question closes and the cancel goes out again until Rijan confirms.
  rijan.paired = true;
  await at(f.clock.now() + 2 * 61_000);
  expect(asks(f, parent)).toEqual([]);
  expect(rijan.cancels.length).toBeGreaterThan(sent);
  expect(ledger.children(caller)[0]).toMatchObject({ state: "cancelling", contact: "unconfirmed" });
});

it("the person stops tracking an unconfirmed child whose machine was unpaired: it settles cancelled, still saying it never confirmed", async () => {
  const { f, parent, rijan, ledger, at, id, caller } = await stoppedUnconfirmed();
  await f.complete(parent.threadId, "Stopped the review.");
  rijan.paired = false;
  await at(f.clock.now() + 61_000);
  const [ask] = asks(f, parent);
  if (!ask) throw new Error("No question for the person");

  expect(stopTracking(ledger, ask.id)).toMatchObject({ ok: true });
  await f.engine.flush();
  expect(asks(f, parent)).toEqual([]);
  expect(ledger.children(caller)).toEqual([
    expect.objectContaining({
      id,
      state: "cancelled",
      contact: "unconfirmed",
      result: expect.stringContaining(
        "no longer paired with this machine, so the stop can't be confirmed",
      ),
    }),
  ]);
  expect(live).not.toContain(parentView(f, parent).status.state);

  // Never asked about or cancelled again, even once paired back.
  const sent = rijan.cancels.length;
  rijan.paired = true;
  await at(f.clock.now() + 5 * 61_000);
  expect(rijan.cancels.length).toBe(sent);
  expect(asks(f, parent)).toEqual([]);
  expect(ledger.children(caller)[0]?.state).toBe("cancelled");
});

it("a machine that no longer has the stopped child ends its cancel retries, and the child settles cancelled", async () => {
  const { f, rijan, ledger, at, id, caller } = await stoppedUnconfirmed();
  rijan.onCancel = () => {
    throw new MachineFailure("refused", "not_found");
  };
  await at(f.clock.now() + 61_000);
  expect(ledger.children(caller)).toEqual([
    expect.objectContaining({
      id,
      state: "cancelled",
      result: expect.stringContaining("no longer has this child"),
    }),
  ]);
  const sent = rijan.cancels.length;
  await at(f.clock.now() + 5 * 61_000);
  expect(rijan.cancels.length).toBe(sent);
});

it("a child whose machine confirms the cancel ends with its real outcome and no warning", async () => {
  const { f, parent, rijan, ledger, at } = await parentWithChildren(1);
  const [id] = ids;
  if (!id) throw new Error("no child");
  rijan.onCancel = (cancelled) =>
    rijan.views.set(cancelled, {
      ...notSent(id),
      state: "cancelled",
      status: { state: "done" },
      result: "Stopped.",
      truncated: false,
    });
  ledger.stop(id);
  await at(f.clock.now() + 1_000);
  expect(ledger.watched(id)?.view).toMatchObject({ state: "cancelled", result: "Stopped." });
  expect(ledger.watched(id)?.view.contact).toBeUndefined();
  expect(rijan.cancels).toEqual([id]);
  expect(parentView(f, parent).holds.map((hold) => hold.status)).toEqual(["stopped"]);
});

it("a child stopped without confirmation is never revived by a late report, but takes its real end", async () => {
  const { f, rijan, ledger, at } = await parentWithChildren(1);
  const [id] = ids;
  if (!id) throw new Error("no child");
  ledger.stop(id);
  await at(f.clock.now() + stopBound(REMOTE_STOP) + 1);
  await at(f.clock.now() + 1);
  expect(ledger.child(id)?.settled).toBe(true);

  // Still working there, read on a re-check: it stays stopped here.
  rijan.views.set(id, {
    ...notSent(id),
    state: "working",
    status: { state: "working", agents: 1 },
  });
  for (let poll = 0; poll < 12; poll++) await at(f.clock.now() + 10_000);
  expect(ledger.watched(id)?.view).toMatchObject({ state: "cancelled", contact: "unconfirmed" });

  // It ends there: its real end is recorded, still settled.
  rijan.views.set(id, {
    ...notSent(id),
    state: "done",
    status: { state: "done" },
    result: "Finished after all.",
    truncated: false,
  });
  for (let poll = 0; poll < 12; poll++) await at(f.clock.now() + 10_000);
  expect(ledger.child(id)?.settled).toBe(true);
  expect(ledger.watched(id)?.view).toMatchObject({ state: "done", result: "Finished after all." });
});

it("a stop and a lease kept across a daemon restart are read again at startup", async () => {
  const first = await parentWithChildren(2);
  const [stopped, quiet] = ids;
  if (!stopped || !quiet) throw new Error("no children");
  first.rijan.views.set(quiet, {
    ...notSent(quiet),
    state: "working",
    status: { state: "working", agents: 1 },
  });
  await first.at(first.f.clock.now() + 1_000);
  first.ledger.stop(stopped);
  await first.at(first.f.clock.now() + 1);
  expect(first.rijan.cancels).toEqual([stopped]);
  first.ledger.close();

  // The daemon is down for an hour; its machine stopped answering meanwhile.
  first.rijan.silent = true;
  const boot = first.f.clock.now() + 60 * 60_000;
  first.f.clock.advance(boot);
  const restarted = children(first.f, first.rijan);
  await first.at(boot, restarted);
  // The stop is past its bound: stopped at once, without another round of cancels.
  expect(restarted.watched(stopped)?.view).toMatchObject({
    state: "cancelled",
    contact: "unconfirmed",
  });
  // Downtime here isn't silence there: the lease counts from startup.
  expect(restarted.watched(quiet)?.view.state).toBe("working");
  await first.at(boot + REMOTE_CHILD_LEASE_MS + 1_000, restarted);
  // Lost contact is not knowing: the parent still holds it and asks the person.
  expect(restarted.watched(quiet)?.view).toMatchObject({ state: "needs_you", contact: "lost" });
  expect(parentView(first.f, first.parent).status.state).toBe("needs_you");
  restarted.close();
});

it("the parent is never shown done while one of its children is still live", async () => {
  const { f, parent, rijan, ledger, at } = await parentWithChildren(2);
  const [stopped, running] = ids;
  if (!stopped || !running) throw new Error("no children");
  rijan.views.set(running, {
    ...notSent(running),
    state: "working",
    status: { state: "working", agents: 1 },
  });
  ledger.stop(stopped);
  await at(f.clock.now() + stopBound(REMOTE_STOP) + 1);
  await at(f.clock.now() + 1);
  expect(ledger.watched(stopped)?.view.contact).toBe("unconfirmed");
  const view = parentView(f, parent);
  expect(live).toContain(view.status.state);
  expect(view.forest.roots.some((root) => root.live)).toBe(true);
  expect(view.rows.filter((row) => row.live)).toHaveLength(1);
});
