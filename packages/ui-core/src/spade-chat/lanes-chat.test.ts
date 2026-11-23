import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  spadeBubbles,
  spadeQuietLine,
  spadeView,
} from "./index.ts";

/** Main's conversation fed the events Spade stores for its lanes (ADR 0217). */
function main() {
  const state = emptySpadeConversation();
  let seq = 0;
  const stored = (event: Record<string, unknown>) => {
    const input = parseSpadeLiveFrame(
      "stored",
      JSON.stringify({ seq: ++seq, at: 1000 + seq, event }),
    );
    if (input) foldSpade(state, input);
  };
  const bubbles = () => spadeBubbles(spadeView(state));
  /** Each quiet line as it reads, each bubble by its kind (a bot's with its words). */
  const lines = () =>
    bubbles().map((bubble) =>
      bubble.kind === "quiet"
        ? spadeQuietLine(bubble.quiet).label
        : bubble.kind === "bot"
          ? `bot: ${bubble.text}`
          : bubble.kind,
    );
  return { stored, bubbles, lines };
}

const report = (lane: string, name: string, state: string) => ({
  type: "worker_reported",
  worker: lane,
  kind: "lane",
  name,
  state,
  epoch: "e1",
  summary: "",
});

describe("main's quiet lines for its tasks", () => {
  test("a task started reads as one line naming it; queued reads the same", () => {
    const c = main();
    c.stored({ type: "user_message", text: "Fix the March invoice" });
    c.stored({
      type: "lane_started",
      lane: "l1",
      conversation: "l1",
      title: "Fix the March invoice",
      call: "k1",
      asks: ["m1"],
    });
    c.stored({
      type: "lane_started",
      lane: "l2",
      conversation: "l2",
      title: "Renew the domain",
      call: "k2",
      asks: [],
      queued: true,
    });
    expect(c.lines()).toEqual([
      "person",
      "Started a task: Fix the March invoice",
      "Started a task: Renew the domain",
    ]);
    const [, started] = c.bubbles();
    expect(started?.kind === "quiet" && started.quiet).toMatchObject({
      kind: "lane",
      lane: "l1",
      event: "started",
    });
  });

  test("main's long work moved to a task is Spade's one line, and its emptied reply leaves nothing", () => {
    const c = main();
    c.stored({ type: "user_message", text: "Draft the quarterly note" });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "lane_started",
      lane: "l1",
      conversation: "l1",
      title: "Draft the quarterly note",
      call: "r1",
      asks: [],
      moved_from: "r1",
    });
    c.stored({
      type: "reply_moved",
      reply: "r1",
      lane: "l1",
      title: "Draft the quarterly note",
      asks: [],
    });
    c.stored({ type: "reply_finished", reply: "r1", text: "" });
    expect(c.lines()).toEqual([
      "person",
      "This is taking a while, so I moved it to its own task: Draft the quarterly note. I'm free to talk.",
    ]);
  });

  test("a message sent to a task reads as sent to it, under the message", () => {
    const c = main();
    c.stored({ type: "user_message", text: "Send it to her work address" });
    c.stored({ type: "ask_routed", lane: "l1", title: "Fix the March invoice", message: "m5" });
    expect(c.lines()).toEqual(["person", "Sent to Fix the March invoice"]);
  });

  test("a task's report reads done, stopped early, stopped, or needs you", () => {
    const c = main();
    c.stored(report("l1", "Clean up the drive", "done"));
    c.stored(report("l2", "Compare the quotes", "failed"));
    c.stored(report("l3", "Renew the domain", "stopped"));
    c.stored(report("l4", "Book flights", "needs_you"));
    c.stored(report("l5", "Sort the photos", "finished"));
    c.stored(report("l6", "Still going", "stopping"));
    expect(c.lines()).toEqual([
      "Task done: Clean up the drive",
      "Task stopped early: Compare the quotes",
      "Task stopped: Renew the domain",
      "Book flights needs you",
      "Task done: Sort the photos",
    ]);
    // Stopped early, it names the reply Try again answers again.
    const failed = c.bubbles()[1];
    expect(failed?.kind === "quiet" && failed.quiet).toMatchObject({ lane: "l2", reply: "e1" });
  });
});

describe("a task's request in main", () => {
  test("stands on its own, names the task, and is not one of main's replies' calls", () => {
    const c = main();
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "reply_finished", reply: "r1", text: "Started on the flights." });
    c.stored({
      type: "approval_requested",
      reply: "r-lane",
      call_id: "l1.k1",
      name: "browser_act",
      arguments: { action: "click", target: "Pay €412 to TAP Air Portugal" },
      lane: { task: "l1", conversation: "l1", call_id: "k1", title: "Book flights to Lisbon" },
    });
    const asks = c.bubbles().filter((bubble) => bubble.kind === "ask");
    expect(asks).toHaveLength(1);
    expect(asks[0]?.kind === "ask" && asks[0].lane).toEqual({
      task: "l1",
      title: "Book flights to Lisbon",
    });
    expect(c.lines()).toEqual(["bot: Started on the flights.", "ask"]);
  });
});
