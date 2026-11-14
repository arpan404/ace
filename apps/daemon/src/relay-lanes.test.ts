import { expect, it } from "vitest";
import { BULK, INTERACTIVE } from "@ace/secure-channel";
import { LaneRouter } from "./relay-lanes.ts";

const snapshot = (subscriptionId: string) =>
  JSON.stringify({ type: "snapshot", subscriptionId, seq: 1, view: { kind: "thread" } });
const events = (subscriptionId: string) =>
  JSON.stringify({ type: "events", subscriptionId, afterSeq: 1, throughSeq: 2, events: [] });
const page = (requestId: string) =>
  JSON.stringify({ type: "entities.page", requestId, page: { threadId: "t", seq: 1 } });
const threadsPatch = JSON.stringify({ type: "threads.patch", patch: [] });

it("an approval for another thread overtakes a snapshot in flight", () => {
  const router = new LaneRouter();
  expect(router.route(snapshot("a")).lane).toBe(BULK);
  expect(router.route(events("b")).lane).toBe(INTERACTIVE);
  expect(router.route(threadsPatch).lane).toBe(INTERACTIVE);
});

it("a subscription's deltas stay behind its own snapshot until it has gone", () => {
  const router = new LaneRouter();
  const sent = router.route(snapshot("a"));
  expect(router.route(events("a")).lane).toBe(BULK);
  sent.sent();
  // The held delta still orders what follows on its subscription.
  expect(router.route(events("a")).lane).toBe(BULK);
});

it("once the bulk lane is empty, everything is interactive again", () => {
  const router = new LaneRouter();
  const first = router.route(snapshot("a"));
  const delta = router.route(events("a"));
  first.sent();
  delta.sent();
  expect(router.route(events("a")).lane).toBe(INTERACTIVE);
});

it("deltas wait behind a queued page, other replies do not", () => {
  const router = new LaneRouter();
  expect(router.route(page("r1")).lane).toBe(BULK);
  expect(router.route(events("b")).lane).toBe(BULK);
  expect(router.route(JSON.stringify({ type: "pong" })).lane).toBe(INTERACTIVE);
  expect(router.route(JSON.stringify({ type: "error", requestId: "r1" })).lane).toBe(BULK);
});

it("a message the router cannot read waits, and holds back everything after it", () => {
  const router = new LaneRouter();
  router.route(snapshot("a"));
  const opaque = router.routeOpaque();
  expect(opaque.lane).toBe(BULK);
  expect(router.route(threadsPatch).lane).toBe(BULK);
  expect(router.route(`{"type":"other","data":"${"x".repeat(70_000)}"}`).lane).toBe(BULK);
});

it("a bulk message whose ids aren't where the daemon writes them is a barrier", () => {
  const router = new LaneRouter();
  router.route(JSON.stringify({ type: "snapshot", seq: 1, subscriptionId: "a" }));
  expect(router.route(events("b")).lane).toBe(BULK);
});

it("channel.close always goes last", () => {
  const router = new LaneRouter();
  router.route(snapshot("a"));
  expect(router.route(JSON.stringify({ type: "channel.close", code: 1000 })).lane).toBe(BULK);
});

it("a packed frame with a delta for a subscription with a queued snapshot waits whole", () => {
  const router = new LaneRouter();
  router.route(snapshot("a"));
  expect(router.route(`${events("b")}\n${events("a")}`).lane).toBe(BULK);
  // And holds back later deltas of both subscriptions.
  expect(router.route(events("b")).lane).toBe(BULK);
});
