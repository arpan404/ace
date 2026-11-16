import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  spadeBubbles,
  spadeView,
} from "./index.ts";

function conversation() {
  const state = emptySpadeConversation();
  let seq = 0;
  const stored = (event: Record<string, unknown>) => {
    const input = parseSpadeLiveFrame("stored", JSON.stringify({ seq: ++seq, at: seq, event }));
    if (input) foldSpade(state, input);
  };
  return { stored, view: () => spadeView(state) };
}

/** The bot's reply that starts a helper on `task`, as job `j1`. */
function startsHelper(c: ReturnType<typeof conversation>, task: string) {
  c.stored({ type: "user_message", text: "Why did CI fail?" });
  c.stored({ type: "reply_started", reply: "r1" });
  c.stored({
    type: "step_finished",
    reply: "r1",
    text: "",
    calls: [{ id: "j1", name: "helper", arguments: { task, profile: "explore" } }],
  });
  c.stored({ type: "tool_started", reply: "r1", call_id: "j1", name: "helper" });
  c.stored({ type: "job_started", reply: "r1", job: "j1", name: "helper" });
  c.stored({ type: "tool_finished", reply: "r1", call_id: "j1", name: "helper", content: "" });
}

const helperLines = (c: ReturnType<typeof conversation>) =>
  spadeBubbles(c.view()).flatMap((bubble) => (bubble.kind === "helper" ? [bubble.text] : []));

describe("a helper in its bot's conversation", () => {
  test("is one line that says what it looks into, then what it found", () => {
    const c = conversation();
    startsHelper(c, "Read the build log");
    c.stored({ type: "step_finished", reply: "r1", text: "A helper is reading the log." });
    c.stored({ type: "reply_finished", reply: "r1", text: "A helper is reading the log." });
    expect(helperLines(c)).toEqual(["Helper looking into: Read the build log"]);
    // Its reply is over, but the helper still works: never done while it does.
    expect(c.view()).toMatchObject({ answering: false, busy: true });

    c.stored({
      type: "job_finished",
      job: "j1",
      name: "helper",
      content: "Step 3 failed: the disk was full.\nMore detail follows.",
    });
    expect(helperLines(c)).toEqual(["Helper found: Step 3 failed: the disk was full."]);
    expect(c.view().busy).toBe(false);
    // The same line, updated in place: no separate job entry.
    expect(c.view().entries.filter((entry) => entry.kind === "job")).toEqual([]);
  });

  test("reads as stopped when the person stopped it", () => {
    const c = conversation();
    startsHelper(c, "Read every log");
    c.stored({ type: "stop_requested", reply: "r1", jobs: ["j1"] });
    c.stored({ type: "reply_stopped", reply: "r1", text: "" });
    c.stored({ type: "job_finished", job: "j1", name: "helper", content: "", is_error: true });
    expect(helperLines(c)).toEqual(["Helper stopped"]);
  });

  test("asks the person here, past the end of the reply that started it, until it ends", () => {
    const c = conversation();
    startsHelper(c, "Send Sam the note");
    c.stored({ type: "step_finished", reply: "r1", text: "On it." });
    c.stored({
      type: "approval_requested",
      reply: "r1",
      call_id: "j1.call_0",
      name: "send_email",
      arguments: { to: "Sam" },
      helper: { job: "j1", conversation: "h1", call_id: "call_0" },
    });
    c.stored({ type: "reply_finished", reply: "r1", text: "On it." });
    const view = c.view();
    expect(view.approvals).toMatchObject([
      { callId: "j1.call_0", helper: { job: "j1", task: "Send Sam the note" } },
    ]);
    expect(view.approvals[0]?.sentence).toBe("A helper of Spade wants to send an email.");
    expect(helperLines(c)).toEqual(["Helper waiting for you: Send Sam the note"]);

    c.stored({ type: "job_finished", job: "j1", name: "helper", content: "Sent." });
    expect(c.view().approvals).toEqual([]);
    expect(helperLines(c)).toEqual(["Helper found: Sent."]);
  });
});
