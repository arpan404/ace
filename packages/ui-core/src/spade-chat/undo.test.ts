import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  parseSpadeUndoPreview,
  spadeBubbles,
  spadeUndoSummary,
  spadeView,
  type SpadeBubble,
} from "./index.ts";

/** A conversation fed stored events as the live stream sends them; `seq` of each is returned. */
function conversation() {
  const state = emptySpadeConversation();
  let seq = 0;
  const stored = (event: Record<string, unknown>) => {
    const input = parseSpadeLiveFrame(
      "stored",
      JSON.stringify({ seq: ++seq, at: 1000 + seq, event }),
    );
    if (input) foldSpade(state, input);
    return seq;
  };
  return { stored, bubbles: () => spadeBubbles(spadeView(state)) };
}

type Steps = Extract<SpadeBubble, { kind: "steps" }>;

/** One reply calling `calls` in turn; answers each call's `tool_started` position by id. */
function reply(calls: { id: string; name: string; arguments: unknown; risk?: string }[]) {
  const c = conversation();
  const started = new Map<string, number>();
  c.stored({ type: "user_message", text: "Go" });
  c.stored({ type: "reply_started", reply: "r1" });
  c.stored({
    type: "step_finished",
    reply: "r1",
    text: "",
    calls: calls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
  });
  for (const call of calls) {
    started.set(
      call.id,
      c.stored({
        type: "tool_started",
        reply: "r1",
        call_id: call.id,
        name: call.name,
        ...(call.risk ? { risk: call.risk } : {}),
      }),
    );
    c.stored({
      type: "tool_finished",
      reply: "r1",
      call_id: call.id,
      name: call.name,
      content: "ok",
      is_error: false,
    });
  }
  c.stored({ type: "step_finished", reply: "r1", text: "Done." });
  c.stored({ type: "reply_finished", reply: "r1", text: "Done.", cost_micros: 0 });
  const steps = c.bubbles().find((b): b is Steps => b.kind === "steps");
  return { steps, started };
}

describe("undo in the conversation", () => {
  test("a step that wrote the bot's files can be undone from where it started", () => {
    const { steps, started } = reply([
      { id: "c1", name: "workspace_write", arguments: { path: "plan.md", content: "x" } },
      { id: "c2", name: "workspace_edit", arguments: { path: "plan.md", old: "x", new: "y" } },
    ]);
    expect(steps?.steps.map((step) => step.undoFrom)).toEqual([
      started.get("c1"),
      started.get("c2"),
    ]);
    // The whole turn undoes from its first file-changing step.
    expect(steps?.undo).toEqual({ from: started.get("c1"), stays: [] });
  });

  test("a send can't be undone and says so, on its step and in the turn's undo", () => {
    const { steps } = reply([
      { id: "c1", name: "workspace_write", arguments: { path: "draft.md", content: "Hi" } },
      { id: "c2", name: "send_email", arguments: { subject: "Hi" } },
    ]);
    const send = steps?.steps.find((step) => step.key === "c2");
    expect(send?.cantUndo).toBe("Can't be undone: it was sent.");
    expect(send?.undoFrom).toBeUndefined();
    expect(send?.notable).toBe(true);
    expect(steps?.undo?.stays).toEqual(["Sent an email"]);
  });

  test("a push, a payment and an app's change each say why they stay", () => {
    const { steps } = reply([
      { id: "c1", name: "git_push", arguments: { branch: "spade/x" } },
      { id: "c2", name: "stripe__create_payment", arguments: {} },
      { id: "c3", name: "linear__update_issue", arguments: {}, risk: "write" },
    ]);
    expect(steps?.steps.map((step) => step.cantUndo)).toEqual([
      "Can't be undone: the push already left this computer.",
      "Can't be undone: a payment can't be taken back from here.",
      "Can't be undone here: it changed linear.",
    ]);
    expect(steps?.undo).toBeUndefined();
  });

  test("reading files has nothing to undo", () => {
    const { steps } = reply([{ id: "c1", name: "workspace_read", arguments: { path: "a.md" } }]);
    expect(steps?.steps[0]?.undoFrom).toBeUndefined();
    expect(steps?.steps[0]?.cantUndo).toBeUndefined();
    expect(steps?.undo).toBeUndefined();
  });

  test("the preview says what goes back before anything does", () => {
    const preview = parseSpadeUndoPreview({
      checkpoint: { id: "cp_1", at: 5 },
      changes: { changed: ["plan.md"], added: ["a.md", "b.md"], deleted: ["old.md"], more: 0 },
    });
    expect(preview?.changed).toEqual(["plan.md"]);
    expect(preview && spadeUndoSummary(preview)).toBe(
      "1 file goes back, 2 files made since go and 1 file removed since comes back",
    );
    const same = parseSpadeUndoPreview({
      checkpoint: { id: "cp_1", at: 5 },
      changes: { changed: [], added: [], deleted: [], more: 0 },
    });
    expect(same && spadeUndoSummary(same)).toBe("Nothing to undo");
    expect(parseSpadeUndoPreview({ error: "no" })).toBeUndefined();
  });
});
