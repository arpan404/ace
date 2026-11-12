import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  parseSpadeRoutines,
  spadeBubbles,
  spadeRunWords,
  spadeView,
  spadeWhen,
} from "./index.ts";

function conversation() {
  const state = emptySpadeConversation();
  let seq = 0;
  const stored = (event: Record<string, unknown>) => {
    const input = parseSpadeLiveFrame("stored", JSON.stringify({ seq: ++seq, at: seq, event }));
    if (input) foldSpade(state, input);
  };
  const bubbles = () =>
    spadeBubbles(spadeView(state)).map((bubble) =>
      bubble.kind === "routine"
        ? `label: ${bubble.name} · ${bubble.label}`
        : bubble.kind === "person"
          ? `person: ${bubble.text}`
          : bubble.kind === "bot"
            ? `bot: ${bubble.text}`
            : bubble.kind,
    );
  return { stored, bubbles };
}

const fromRoutine = (heartbeat: boolean, label = "9:00") => ({
  id: "rt_1",
  name: heartbeat ? "Heartbeat" : "Daily briefing",
  run: `run_${label}`,
  label,
  heartbeat,
});

describe("a routine in the conversation", () => {
  test("shows as its label, never as the person, and the bot's reply follows", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Brief me.", from_routine: fromRoutine(false) });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "reply_finished", reply: "r1", text: "Three things today." });
    expect(c.bubbles()).toEqual(["label: Daily briefing · 9:00", "bot: Three things today."]);
  });

  test("a heartbeat with nothing to report shows nothing; one that has something shows only that", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Check.", from_routine: fromRoutine(true) });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "reply_progress", reply: "r1", text: "[qui" });
    expect(c.bubbles()).toEqual([]);
    c.stored({ type: "reply_finished", reply: "r1", text: "[quiet]" });
    c.stored({ type: "user_message", text: "Check.", from_routine: fromRoutine(true, "9:30") });
    c.stored({ type: "reply_started", reply: "r2" });
    c.stored({ type: "reply_finished", reply: "r2", text: "The build is red." });
    expect(c.bubbles()).toEqual(["bot: The build is red."]);
  });

  test("a heartbeat reply that said something before ending with [quiet] shows all it said", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Check.", from_routine: fromRoutine(true) });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "step_finished", reply: "r1", text: "The deploy failed twice." });
    c.stored({ type: "step_finished", reply: "r1", text: "[quiet]" });
    c.stored({ type: "reply_finished", reply: "r1", text: "[quiet]" });
    c.stored({ type: "user_message", text: "Check.", from_routine: fromRoutine(true, "9:30") });
    c.stored({ type: "reply_started", reply: "r2" });
    c.stored({ type: "step_finished", reply: "r2", text: "[quiet]" });
    c.stored({ type: "reply_finished", reply: "r2", text: "[quiet]" });
    expect(c.bubbles()).toEqual(["bot: The deploy failed twice.\n\n[quiet]"]);
  });

  test("a quiet answer to the person's queued message and a later heartbeat still shows", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Did the deploy finish?" });
    c.stored({ type: "user_message", text: "Check.", from_routine: fromRoutine(true) });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "reply_finished", reply: "r1", text: "[quiet]" });
    expect(c.bubbles()).toEqual(["person: Did the deploy finish?", "bot: [quiet]"]);
  });

  test("a quiet answer that also answered the person still shows", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Check.", from_routine: fromRoutine(true) });
    c.stored({ type: "user_message", text: "anything?" });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({ type: "reply_finished", reply: "r1", text: "[quiet]" });
    expect(c.bubbles()).toEqual(["person: anything?", "bot: [quiet]"]);
  });
});

describe("the routine list", () => {
  test("reads Spade's routines and says how the last run went", () => {
    const routines = parseSpadeRoutines(
      JSON.stringify({
        routines: [
          {
            id: "rt_1",
            name: "Daily briefing",
            instruction: "Brief me.",
            trigger: { kind: "schedule", schedule: "weekdays at 9:00" },
            words: "Weekdays at 9:00",
            time_zone: "Europe/London",
            paused: false,
            next_run: 1,
            last_run: {
              id: "run_1",
              at: 1,
              cause: "schedule",
              result: "skipped",
              detail: "The last run was still going.",
            },
            webhook: null,
            created_by: "agent",
          },
          { name: "no id" },
        ],
      }),
    );
    expect(routines?.map((r) => r.words)).toEqual(["Weekdays at 9:00"]);
    const last = routines?.[0]?.lastRun;
    expect(last && spadeRunWords(last)).toBe("Skipped. The last run was still going.");
  });

  test("says when in the routine's zone, relative to today", () => {
    const now = Date.parse("2026-11-12T12:00:00Z");
    expect(spadeWhen(Date.parse("2026-11-12T17:00:00Z"), now, "UTC")).toBe("17:00");
    expect(spadeWhen(Date.parse("2026-11-13T09:00:00Z"), now, "UTC")).toBe("Tomorrow 9:00");
    expect(spadeWhen(Date.parse("2026-11-16T09:00:00Z"), now, "UTC")).toBe("Mon 9:00");
    expect(spadeWhen(Date.parse("2026-12-01T09:00:00Z"), now, "UTC")).toBe("Dec 1, 9:00");
    // 9:00 in New York is 14:00 UTC.
    expect(spadeWhen(Date.parse("2026-11-12T14:00:00Z"), now, "America/New_York")).toBe("9:00");
  });
});
