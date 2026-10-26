import { expect, it } from "vitest";
import { AgentId, ThreadId } from "@ace/protocol";
import { STATUS_CALLS_PER_POLL, STATUS_IDS_PER_CALL } from "./child-paging.ts";
import { done, machine, message, parent, working } from "./children-test-support.ts";
import { MachineFailure } from "./transport.ts";

const caller = (threadId: ThreadId) => ({
  sessionId: "session",
  threadId,
  agentId: AgentId.parse("agent"),
});
const range = (count: number, name: (index: number) => string) =>
  Array.from({ length: count }, (_, index) => name(index));

it("with more than 64 children on several machines and the oldest never settling, later children's results still reach their parents", async () => {
  const h = machine();
  // Delegated first, and never finishing: on both machines they outnumber any one read.
  const stuck = [
    ...range(70, (index) => `a-studio-${String(index).padStart(2, "0")}`).map((id) => h.add(id)),
    ...range(30, (index) => `a-laptop-${String(index).padStart(2, "0")}`).map((id) =>
      h.add(id, "laptop"),
    ),
  ];
  for (const id of stuck) h.report(id, working);
  const late = [
    ...range(10, (index) => `z-studio-${index}`).map((id) => h.add(id)),
    ...range(10, (index) => `z-laptop-${index}`).map((id) => h.add(id, "laptop")),
  ];
  for (const id of late) h.report(id, done(`Result of ${id}`));

  for (let poll = 0; poll < 4; poll++) {
    h.asked.length = 0;
    await h.fire();
    // Each poll stays within its status calls, however many children wait.
    expect(h.asked.length).toBeLessThanOrEqual(STATUS_CALLS_PER_POLL);
    expect(h.asked.every((ids) => ids.length <= STATUS_IDS_PER_CALL)).toBe(true);
  }
  for (const id of late) {
    expect(h.state(id), id).toBe("done");
    expect(h.delivered.join("\n")).toContain(`Result of ${id}`);
  }
  for (const id of stuck) expect(h.state(id), id).toBe("working");
});

it("five machines kept full of children, with more arriving on four, still all get read: the fifth machine's results arrive", async () => {
  const h = machine();
  const busy = ["a", "b", "c", "d"];
  for (const host of [...busy, "e"])
    for (const id of range(70, (index) => `${host}-${String(index).padStart(2, "0")}`))
      h.report(h.add(id, host), working);
  const late = h.add("e-zz-late", "e");
  h.report(late, done("Finished on the fifth machine."));

  let fresh = 0;
  for (let poll = 0; poll < 6; poll++) {
    // Each poll, every busy machine gets another child that never settles.
    for (const host of busy) h.report(h.add(`${host}-new-${fresh}`, host), working);
    fresh++;
    h.asked.length = 0;
    await h.fire();
    expect(h.asked.length).toBeLessThanOrEqual(STATUS_CALLS_PER_POLL);
  }
  expect(h.state(late)).toBe("done");
  expect(h.delivered.join("\n")).toContain("Finished on the fifth machine.");
});

it("a cascading stop reaches every unsettled child of the stopped tree, however many, and agents_status lists them all", async () => {
  const h = machine();
  const helper = ThreadId.parse("helper");
  const other = ThreadId.parse("other");
  h.edges.set(helper, parent);
  const mine = range(70, (index) => `mine-${index}`).map((id) => h.add(id));
  const helpers = range(10, (index) => `helper-${index}`).map((id) => h.add(id, "laptop", helper));
  const others = range(5, (index) => `other-${index}`).map((id) => h.add(id, "studio", other));
  for (const id of [...mine, ...helpers, ...others]) h.report(id, working);
  // Two of the parent's children finished: nothing is left to stop there.
  const finished = mine.slice(0, 2);
  for (const id of finished) h.report(id, done("Finished."));
  for (let poll = 0; poll < 3; poll++) await h.fire();
  for (const id of finished) expect(h.state(id)).toBe("done");

  const stopped = new Set(h.children.under(parent));
  expect(stopped).toEqual(new Set([...mine.slice(2), ...helpers]));
  // The helper's own stop reaches only its children.
  expect(new Set(h.children.under(helper))).toEqual(new Set(helpers));

  const listed = h.children.children(caller(parent));
  expect(listed.map((child) => child.id).toSorted()).toEqual([...mine, ...helpers].toSorted());
  expect(listed.filter((child) => child.state === "working")).toHaveLength(78);
});

it("a child whose pairing was removed here settles with a lost result its parent gets, and stops being retried", async () => {
  const h = machine();
  const id = h.add("child");
  h.report(id, working);
  await h.fire();
  // A message to it is still unanswered: its machine can't be reached.
  h.answers.resend = async () => {
    throw new MachineFailure("offline");
  };
  h.children.send(id, message("second"))(undefined);
  await h.fire();
  expect(h.state(id)).toBe("working");

  h.pairings.set("studio", undefined);
  await h.fire();
  const read = h.children.watched(id);
  expect(read?.view.state).toBe("failed");
  expect(read?.outcome).toMatchObject({ outcome: "failed" });
  expect(read?.outcome?.result).toContain("no longer paired");
  expect(h.delivered.join("\n")).toContain("no longer paired");
  // Nothing is left to poll, retry or re-check for it.
  expect(h.timers).toEqual([]);
});

it("children delegated through a pairing since replaced are lost, while children of the new pairing are still watched", async () => {
  const h = machine();
  const before = h.add("before");
  h.report(before, working);
  await h.fire();
  // The machine was linked again: this machine now calls it as a new device, which the other
  // machine never gave the earlier child to.
  h.pairings.set("studio", "device-relinked");
  const after = h.add("after");
  h.report(after, working);
  h.asked.length = 0;
  await h.fire();
  expect(h.state(before)).toBe("failed");
  expect(h.state(after)).toBe("working");
  expect(h.asked.flat()).toEqual([after]);
});

it("a child whose machine keeps refusing its message stays working, and says why", async () => {
  const h = machine();
  const id = h.add("child");
  h.report(id, done("First pass done."));
  await h.fire();
  expect(h.state(id)).toBe("done");
  h.answers.resend = async () => {
    throw new MachineFailure("refused", "unavailable", "Agents are starting on this machine.");
  };
  h.children.send(id, message("second"))(undefined);
  for (let retry = 0; retry < 5; retry++) {
    h.clock.now += 60_000;
    await h.fire();
  }
  const read = h.children.watched(id);
  expect(read?.view.state).toBe("working");
  expect(read?.outcome).toBeUndefined();
  expect(read?.view.step).toBe("Message waits on Studio: Agents are starting on this machine.");
  expect(h.children.children(caller(parent))[0]?.step).toContain("Message waits on Studio");
});

it("a child on a machine that turned agents off stays working, and says so", async () => {
  const h = machine();
  const id = h.add("child");
  h.report(id, working);
  await h.fire();
  h.reads.error = new MachineFailure("refused", "machine_opted_out", "Turned off.");
  await h.fire();
  expect(h.children.watched(id)?.view).toMatchObject({
    state: "working",
    step: "Studio: agents from other machines are off there",
  });
});

it("a message sent again that its machine rejected before it reached the child is dropped, and the parent hears why", async () => {
  const h = machine();
  const id = h.add("child");
  h.report(id, done("First pass done."));
  await h.fire();
  h.answers.resend = async () => ({ rejected: "Its thread was deleted on this machine." });
  h.children.send(id, message("second"))(undefined);
  await h.fire();
  await h.fire();
  expect(h.delivered.join("\n")).toContain(
    "Your message was not taken there and will not run: Its thread was deleted on this machine.",
  );
  expect(h.resent).toEqual(["second"]);
  expect(h.state(id)).toBe("done");
});
