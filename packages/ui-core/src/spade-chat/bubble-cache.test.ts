import { expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  SpadeBubbleCache,
  spadeBubbles,
  spadeView,
  type SpadeFoldInput,
} from "./index.ts";

/*
 * The bubbles worked out again only from the first entry that changed give exactly what working
 * them out from the start gives, through everything a conversation goes through.
 */

function conversation() {
  const state = emptySpadeConversation();
  const cache = new SpadeBubbleCache();
  let seq = 0;
  const steps: { cached: unknown; whole: unknown }[] = [];
  const check = () => {
    const view = spadeView(state);
    steps.push({ cached: cache.bubbles(view), whole: spadeBubbles(view) });
  };
  const input = (next: SpadeFoldInput | undefined) => {
    if (next) foldSpade(state, next);
    check();
  };
  return {
    steps,
    cache,
    state,
    stored: (event: Record<string, unknown>) =>
      input(parseSpadeLiveFrame("stored", JSON.stringify({ seq: ++seq, at: 1000 + seq, event }))),
    delta: (reply: string, text: string) => input({ kind: "delta", reply, text }),
    sent: (key: string, text: string) => input({ kind: "sent", key, text }),
    refused: (key: string) => input({ kind: "refused", key }),
  };
}

test("through messages, replies, approvals, jobs, files, failures and sends, it matches a whole pass", () => {
  const c = conversation();
  c.stored({ type: "user_message", text: "Find the notes" });
  c.stored({ type: "reply_started", reply: "r1" });
  c.delta("r1", "Looking");
  c.delta("r1", " now");
  c.stored({
    type: "step_finished",
    reply: "r1",
    text: "Looking now",
    calls: [{ id: "c1", name: "send_email" }],
  });
  c.stored({ type: "approval_requested", reply: "r1", call_id: "c1", name: "send_email" });
  c.sent("k1", "Also this");
  c.stored({ type: "approval_answered", reply: "r1", call_id: "c1", allowed: true });
  c.stored({ type: "tool_started", reply: "r1", call_id: "c1", name: "send_email" });
  c.stored({ type: "tool_finished", reply: "r1", call_id: "c1", content: "sent", is_error: false });
  c.stored({ type: "job_started", reply: "r1", job: "j1", name: "research" });
  c.stored({ type: "reply_finished", reply: "r1", text: "Sent it." });
  c.stored({ type: "user_message", text: "Also this" });
  c.refused("k1");
  c.stored({ type: "job_finished", job: "j1", name: "research", content: "", is_error: false });
  c.stored({ type: "reply_started", reply: "r2" });
  c.delta("r2", "[qui");
  c.stored({ type: "reply_finished", reply: "r2", text: "[quiet]" });
  c.stored({ type: "user_message", text: "And now?" });
  c.stored({ type: "reply_started", reply: "r3" });
  c.delta("r3", "Trying");
  c.stored({ type: "approval_requested", reply: "r3", call_id: "c2", name: "screen_act" });
  c.stored({ type: "reply_failed", reply: "r3", text: "", error: "the model is overloaded" });
  c.sent("k2", "Again?");

  expect(c.steps.length).toBeGreaterThan(20);
  for (const [index, step] of c.steps.entries())
    expect(step.cached, `after input ${index}`).toEqual(step.whole);
});

test("a reply's live words leave every bubble before it as it was", () => {
  const c = conversation();
  for (let index = 0; index < 50; index++) {
    c.stored({ type: "user_message", text: `Question ${index}` });
    c.stored({ type: "reply_started", reply: `r${index}` });
    c.stored({ type: "reply_finished", reply: `r${index}`, text: `Answer ${index}` });
  }
  c.stored({ type: "user_message", text: "One more" });
  c.stored({ type: "reply_started", reply: "live" });
  const before = c.cache.bubbles(spadeView(c.state));

  c.delta("live", "Writing");

  const after = c.cache.bubbles(spadeView(c.state));
  expect(after).toEqual(spadeBubbles(spadeView(c.state)));
  expect(after.slice(0, 101)).toEqual(before.slice(0, 101));
  for (let index = 0; index < 101; index++) expect(after[index]).toBe(before[index]);
});
