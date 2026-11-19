import { expect, it } from "vitest";
import { MonitorSnapshot, ThreadId, type MonitoredChild } from "@ace/protocol";
import { checkedChild, snapshotOf, unreadableChild } from "./snapshot-rows.ts";

const row = (index: number, state: MonitoredChild["state"]): MonitoredChild => ({
  id: ThreadId.parse(`child-${index}`),
  role: `part-${index}`,
  state,
  elapsedSeconds: index,
});
const identity = { id: ThreadId.parse("odd"), role: "Review-on-studio", machine: "Studio" };

it("a tree larger than the list still validates, counts every child and says how many it left out", () => {
  const rows = [
    ...Array.from({ length: 70 }, (_, index) => row(index, "done")),
    row(70, "working"),
    row(71, "queued"),
    row(72, "needs_you"),
    row(73, "unknown"),
    row(74, "cancelling"),
  ];
  const snapshot = MonitorSnapshot.parse(snapshotOf(rows));
  expect(snapshot.children).toHaveLength(64);
  expect(snapshot.omitted).toBe(11);
  expect(snapshot.counts).toEqual({
    working: 1,
    queued: 1,
    needs_you: 1,
    unknown: 1,
    done: 70,
    failed: 0,
    cancelled: 0,
    cancelling: 1,
  });
  // Children still open lead, in the order that matters most; settled ones keep their order.
  expect(snapshot.children.slice(0, 6).map((child) => child.id)).toEqual([
    "child-72",
    "child-73",
    "child-70",
    "child-74",
    "child-71",
    "child-0",
  ]);
});

it("a tree that fits is listed whole, with no omitted count", () => {
  const snapshot = snapshotOf([row(0, "done"), row(1, "working")]);
  expect(snapshot.children.map((child) => child.id)).toEqual(["child-1", "child-0"]);
  expect(snapshot).not.toHaveProperty("omitted");
});

it("a row with a state this build doesn't know keeps the fields that fit and reads unknown", () => {
  const checked = checkedChild(identity, {
    id: "odd",
    role: "Review-on-studio",
    state: "steering",
    step: "reading files",
    elapsedSeconds: 42,
    machine: "Studio",
  });
  expect(checked.child).toEqual({
    id: "odd",
    role: "Review-on-studio",
    state: "unknown",
    step: "reading files",
    elapsedSeconds: 42,
    machine: "Studio",
  });
  expect(checked.problem).toBe("state: invalid_value");
});

it("a row with one oversized field keeps its known state and drops only that field", () => {
  const checked = checkedChild(identity, {
    ...row(1, "needs_you"),
    id: "odd",
    notice: "x".repeat(500),
  });
  expect(checked.child).toMatchObject({ id: "odd", state: "needs_you", elapsedSeconds: 1 });
  expect(checked.child).not.toHaveProperty("notice");
  expect(checked.problem).toBe("notice: too_big");
});

it("a child that couldn't be read at all is listed by its identity as unknown, with the reason", () => {
  const checked = unreadableChild(identity, new Error("view is not JSON"));
  expect(checked.child).toEqual({
    id: "odd",
    role: "Review-on-studio",
    state: "unknown",
    elapsedSeconds: 0,
    machine: "Studio",
  });
  expect(checked.problem).toBe("view is not JSON");
});
