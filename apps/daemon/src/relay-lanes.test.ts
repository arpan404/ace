import { expect, it } from "vitest";
import { BULK, INTERACTIVE } from "@ace/secure-channel";
import { LaneRouter } from "./relay-lanes.ts";

const subscribe = (subscriptionId: string, threadId: string) =>
  JSON.stringify({ type: "subscribe", subscriptionId, scope: { kind: "thread", threadId } });
const snapshot = (subscriptionId: string) =>
  JSON.stringify({ type: "snapshot", subscriptionId, seq: 1, view: { kind: "thread" } });
const events = (subscriptionId: string, threadId: string, ...types: string[]) =>
  JSON.stringify({
    type: "events",
    subscriptionId,
    afterSeq: 1,
    throughSeq: 2,
    events: types.map((type, seq) => ({ seq, threadId, payload: { type } })),
  });
const approval = (subscriptionId: string, threadId: string) =>
  events(subscriptionId, threadId, "interaction.opened");
const page = JSON.stringify({ type: "entities.page", requestId: "r1", page: { threadId: "a" } });
const sidebarPatch = JSON.stringify({ type: "threads.patch", subscriptionId: "side", seq: 3 });
const receipt = JSON.stringify({ type: "commandResult", commandId: "c1", status: "accepted" });

/** A router that knows subscriptions `sa` and `sb` are on threads `a` and `b`. */
function router() {
  const lanes = new LaneRouter();
  lanes.observe(subscribe("sa", "a"));
  lanes.observe(subscribe("sb", "b"));
  return lanes;
}

it("an approval on another thread goes ahead of a thread's snapshot", () => {
  const lanes = router();
  expect(lanes.route(snapshot("sa")).lane).toBe(BULK);
  expect(lanes.route(approval("sb", "b")).lane).toBe(INTERACTIVE);
  expect(lanes.route(events("sb", "b", "item.delta", "item.created")).lane).toBe(INTERACTIVE);
});

it("a sidebar patch saying a thread is done waits behind that thread's queued output", () => {
  const lanes = router();
  lanes.route(snapshot("sa"));
  lanes.route(events("sa", "a", "item.created", "agent.status"));
  expect(lanes.route(sidebarPatch).lane).toBe(BULK);
});

it("a status on any thread waits behind every queued bulk message", () => {
  const lanes = router();
  lanes.route(snapshot("sa"));
  // A child's done could stand for its parent's; the router doesn't know the tree.
  expect(lanes.route(events("sb", "b", "agent.status")).lane).toBe(BULK);
  expect(lanes.route(events("sb", "b", "run.ended")).lane).toBe(BULK);
});

it("a command receipt waits behind the events it confirms", () => {
  const lanes = router();
  lanes.route(snapshot("sa"));
  lanes.route(events("sa", "a", "item.updated"));
  expect(lanes.route(receipt).lane).toBe(BULK);
});

it("once a status waits, later approvals wait behind it too", () => {
  const lanes = router();
  lanes.route(snapshot("sa"));
  lanes.route(events("sb", "b", "agent.status"));
  expect(lanes.route(approval("sb", "b")).lane).toBe(BULK);
});

it("a thread's own approval waits behind its snapshot and the deltas before it", () => {
  const lanes = router();
  const sent = lanes.route(snapshot("sa"));
  expect(lanes.route(approval("sa", "a")).lane).toBe(BULK);
  sent.sent();
  // The approval still waiting keeps the next one behind it.
  expect(lanes.route(approval("sa", "a")).lane).toBe(BULK);
});

it("a snapshot of a subscription the router never saw, and any page, hold back everything", () => {
  const lanes = router();
  lanes.route(snapshot("unknown"));
  expect(lanes.route(approval("sb", "b")).lane).toBe(BULK);
  const other = router();
  other.route(page);
  expect(other.route(approval("sb", "b")).lane).toBe(BULK);
});

it("a pong always goes ahead, and nothing is held once the bulk lane is empty", () => {
  const lanes = router();
  const sent = lanes.route(snapshot("sa"));
  expect(lanes.route(JSON.stringify({ type: "pong" })).lane).toBe(INTERACTIVE);
  sent.sent();
  expect(lanes.route(receipt).lane).toBe(INTERACTIVE);
});

it("a packed frame goes ahead only if every message in it may", () => {
  const lanes = router();
  lanes.route(snapshot("sa"));
  expect(lanes.route(`${approval("sb", "b")}\n${events("sb", "b", "agent.status")}`).lane).toBe(
    BULK,
  );
});

it("a thread subscription closed and reopened elsewhere is no longer about its old thread", () => {
  const lanes = router();
  lanes.observe(JSON.stringify({ type: "unsubscribe", subscriptionId: "sa" }));
  lanes.route(snapshot("sa"));
  expect(lanes.route(approval("sb", "b")).lane).toBe(BULK);
});
