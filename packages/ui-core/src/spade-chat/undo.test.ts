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
function reply(
  calls: { id: string; name: string; arguments: unknown; risk?: string; effect?: string }[],
) {
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
        ...(call.effect ? { effect: call.effect } : {}),
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
      {
        id: "c1",
        name: "workspace_write",
        arguments: { path: "draft.md", content: "Hi" },
        effect: "write_local",
      },
      { id: "c2", name: "send_email", arguments: { subject: "Hi" }, effect: "send_as_person" },
    ]);
    const send = steps?.steps.find((step) => step.key === "c2");
    expect(send?.cantUndo).toBe("Can't be undone: it was sent in your name.");
    expect(send?.undoFrom).toBeUndefined();
    expect(send?.notable).toBe(true);
    expect(steps?.undo?.stays).toEqual(["Sent an email"]);
  });

  test("a payment, a publish, an access change and an app's change each say why they stay", () => {
    const { steps } = reply([
      { id: "c1", name: "stripe__create_payment", arguments: {}, effect: "pay" },
      { id: "c2", name: "npm__release", arguments: {}, effect: "publish" },
      { id: "c3", name: "github__add_collaborator", arguments: {}, effect: "change_access" },
      { id: "c4", name: "linear__update_issue", arguments: {}, risk: "write", effect: "network" },
    ]);
    expect(steps?.steps.map((step) => step.cantUndo)).toEqual([
      "Can't be undone: a payment can't be taken back from here.",
      "Can't be undone: it's published.",
      "Can't be undone here: it changed sign-ins or who has access.",
      "Can't be undone here: it changed linear.",
    ]);
    expect(steps?.undo).toBeUndefined();
  });

  test("a send that failed doesn't say it was sent, only that what got through stays", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Push it" });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "",
      calls: [{ id: "c1", name: "git_push", arguments: { branch: "main" } }],
    });
    c.stored({
      type: "tool_started",
      reply: "r1",
      call_id: "c1",
      name: "git_push",
      effect: "send_as_person",
    });
    c.stored({
      type: "tool_finished",
      reply: "r1",
      call_id: "c1",
      name: "git_push",
      content: "no repository",
      is_error: true,
    });
    c.stored({ type: "reply_finished", reply: "r1", text: "It failed.", cost_micros: 0 });
    const steps = c.bubbles().find((b): b is Steps => b.kind === "steps");
    expect(steps?.steps[0]?.cantUndo).toBe("Can't be undone from here if any of it went through.");
  });

  test("what a step can't undo comes from the gate's declared effect, not the tool's name", () => {
    const { steps } = reply([
      // Named like a payment, declared a read: nothing stays.
      { id: "c1", name: "billing__pay_invoice_preview", arguments: {}, effect: "read" },
      // Named like nothing in particular, declared a send in the person's name: it stays.
      { id: "c2", name: "relay__notify", arguments: {}, effect: "send_as_person" },
      // No effect recorded (an older event): its name alone doesn't make it a send.
      { id: "c3", name: "send_email", arguments: {} },
    ]);
    expect(steps?.steps.map((step) => step.cantUndo)).toEqual([
      undefined,
      "Can't be undone: it was sent in your name.",
      undefined,
    ]);
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
      "1 file goes back, 2 new files are removed and 1 deleted file comes back",
    );
    const same = parseSpadeUndoPreview({
      checkpoint: { id: "cp_1", at: 5 },
      changes: { changed: [], added: [], deleted: [], more: 0 },
    });
    expect(same && spadeUndoSummary(same)).toBe("Nothing to undo");
    expect(parseSpadeUndoPreview({ error: "no" })).toBeUndefined();
  });
});
