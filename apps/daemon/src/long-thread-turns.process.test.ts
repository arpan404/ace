import { expect, test } from "vitest";
import { Item, ItemId, type MessageOrigin } from "@ace/protocol";
import {
  storeFixture,
  userMessage,
  agentMessage,
  start,
  end,
  turns,
} from "./long-thread-test-support.ts";

/*
 * A turn is one ask and every root run after it until the next ask (ADR 0062). Runs here start
 * with the trigger `unknown` where a provider (Claude) cannot say at the start who began a run,
 * so only the asks decide.
 */

type Fixture = ReturnType<typeof storeFixture>;
function send(f: Fixture, id: string, text: string, at: number, extra: object = {}) {
  f.store.appendEvents(
    f.thread.id,
    [{ type: "item.created", item: Item.parse({ ...userMessage(id, text), ...extra }) }],
    at,
  );
}
function answer(f: Fixture, id: string, text: string, run: string, at: number) {
  f.store.appendEvents(
    f.thread.id,
    [{ type: "item.created", item: agentMessage(id, text, run) }],
    at,
  );
}
const origin = (kind: MessageOrigin["kind"]) => ({ synthetic: true, origin: { kind } });

test("a delegated agent's result arriving after the person's message stays in that person's turn", async () => {
  const f = storeFixture();
  send(f, "ask", "Fix the build", 20);
  start(f.store, f.thread, "first", 30, "unknown");
  answer(f, "delegating", "Asked a helper to look", "first", 40);
  end(f.store, f.thread, "first", 50);
  await f.restart();
  // ace delivers the helper's result as a queued root send (origin subagent_result).
  send(
    f,
    "result",
    "[ace-origin:delegation.settled:d1]\nHelper found it",
    60,
    origin("subagent_result"),
  );
  start(f.store, f.thread, "second", 70, "subagent_result");
  expect(turns(f.store, f.thread).turns).toMatchObject([{ ordinal: 1, outcome: "active" }]);
  answer(f, "fixed", "Build fixed", "second", 80);
  end(f.store, f.thread, "second", 90);
  const page = turns(f.store, f.thread);
  expect(page.turns).toHaveLength(1);
  expect(page.turns[0]).toMatchObject({
    ordinal: 1,
    initiatingMessagePreview: "Fix the build",
    latestAgentMessagePreview: "Build fixed",
    outcome: "completed",
    endedAt: 90,
  });
});

test("a new message from the person starts the next turn even when the run's trigger is unknown", () => {
  const f = storeFixture();
  send(f, "ask-1", "First ask", 20);
  start(f.store, f.thread, "first", 30, "unknown");
  end(f.store, f.thread, "first", 40);
  start(f.store, f.thread, "woke", 50, "unknown");
  end(f.store, f.thread, "woke", 60);
  send(f, "ask-2", "Second ask", 70, origin("queue"));
  start(f.store, f.thread, "second", 80, "unknown");
  answer(f, "reply-2", "Second reply", "second", 90);
  end(f.store, f.thread, "second", 100);
  const page = turns(f.store, f.thread);
  expect(page.turns.map((turn) => [turn.ordinal, turn.initiatingMessagePreview])).toEqual([
    [1, "First ask"],
    [2, "Second ask"],
  ]);
});

test("a message steered into the running run stays in its turn and opens none after it", () => {
  const f = storeFixture();
  send(f, "ask", "Refactor the parser", 20);
  start(f.store, f.thread, "first", 30, "unknown");
  send(f, "steer", "Keep the old API", 40, { runId: "first", origin: { kind: "steer" } });
  end(f.store, f.thread, "first", 50);
  start(f.store, f.thread, "carried-on", 60, "unknown");
  answer(f, "done", "Parser refactored", "carried-on", 70);
  end(f.store, f.thread, "carried-on", 80);
  expect(turns(f.store, f.thread).turns).toMatchObject([
    { ordinal: 1, initiatingMessagePreview: "Refactor the parser" },
  ]);
});

test("an ask the running run took leaves no empty turn behind", () => {
  const f = storeFixture();
  send(f, "ask", "Write the docs", 20);
  start(f.store, f.thread, "first", 30, "unknown");
  // Delivered as the run went on: indexed ahead of a run, then bound to the running one.
  send(f, "late", "Also the changelog", 40);
  const late = Item.parse({ ...userMessage("late", "Also the changelog"), runId: "first" });
  f.store.appendEvents(f.thread.id, [{ type: "item.updated", item: late }], 45);
  end(f.store, f.thread, "first", 50);
  start(f.store, f.thread, "woke", 60, "background_completion");
  end(f.store, f.thread, "woke", 70);
  expect(turns(f.store, f.thread).turns).toMatchObject([{ ordinal: 1, outcome: "completed" }]);
});

test("a withdrawn queued message asks nothing, so the next automatic run joins the turn", () => {
  const f = storeFixture();
  send(f, "ask", "Run the tests", 20);
  start(f.store, f.thread, "first", 30, "unknown");
  end(f.store, f.thread, "first", 40);
  send(f, "queued", "Then deploy", 50, origin("queue"));
  f.store.appendEvents(f.thread.id, [{ type: "item.deleted", itemId: ItemId.parse("queued") }], 55);
  start(f.store, f.thread, "woke", 60, "unknown");
  end(f.store, f.thread, "woke", 70);
  expect(turns(f.store, f.thread).turns.map((turn) => turn.ordinal)).toEqual([1]);
});
