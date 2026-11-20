import { describe, expect, test } from "vitest";
import { talkOff, talkStep, type TalkEvent, type TalkState } from "./spade-talk.ts";
import { createVad, defaultVad } from "./spade-vad.ts";

/** Runs events from `state`, collecting every effect in order. */
function run(events: TalkEvent[], state: TalkState = talkOff) {
  const effects: string[] = [];
  let words: string | undefined;
  for (const event of events) {
    const step = talkStep(state, event, 10_000);
    state = step.state;
    effects.push(...step.effects);
    words = step.words ?? words;
  }
  return { state, effects, words };
}

/** A microphone's frames every 20 ms: `quiet` and `loud` levels for the given durations. */
function frames(...spans: [level: number, ms: number][]) {
  const out: { level: number; at: number }[] = [];
  let at = 0;
  for (const [level, ms] of spans)
    for (let end = at + ms; at < end; at += 20) out.push({ level, at });
  return out;
}

describe("voice activity, on the device", () => {
  const quiet = 0.004;
  const voice = 0.08;

  test("talking is noticed once it lasts, and its end after a pause", () => {
    const vad = createVad();
    const events = frames([quiet, 1_000], [voice, 1_200], [quiet, 1_500])
      .map(({ level, at }) => ({ event: vad.step(level, at), at }))
      .filter((each) => each.event);
    expect(events.map((each) => each.event)).toEqual(["speech-start", "speech-end"]);
    const [start, end] = events;
    expect(start?.at).toBeGreaterThanOrEqual(1_000 + defaultVad.startMs);
    expect(end?.at).toBeGreaterThanOrEqual(2_200 + defaultVad.endMs);
  });

  test.each([
    ["a click", frames([quiet, 500], [voice, 60], [quiet, 2_000])],
    ["a steady hum the floor learns", frames([0.008, 4_000])],
  ])("%s is not talking", (_, input) => {
    const vad = createVad();
    expect(input.map(({ level, at }) => vad.step(level, at)).filter(Boolean)).toEqual([]);
  });

  test("talking from the moment the microphone opens is heard", () => {
    const vad = createVad();
    const input = frames([voice, 600], [quiet, 1_200]);
    expect(input.map(({ level, at }) => vad.step(level, at)).filter(Boolean)).toEqual([
      "speech-start",
      "speech-end",
    ]);
  });

  test("a room too loud to fall quiet still ends a stretch of talking", () => {
    const vad = createVad();
    const input = frames([quiet, 200], [voice, defaultVad.longestMs + 500]);
    expect(input.map(({ level, at }) => vad.step(level, at)).filter(Boolean)).toEqual([
      "speech-start",
      "speech-end",
    ]);
  });

  test("a short breath in the middle of a sentence doesn't end it", () => {
    const vad = createVad();
    const input = frames([quiet, 500], [voice, 800], [quiet, 400], [voice, 800]);
    expect(input.map(({ level, at }) => vad.step(level, at)).filter(Boolean)).toEqual([
      "speech-start",
    ]);
  });

  test("while ace speaks, only a voice louder than the echo interrupts", () => {
    const vad = createVad();
    vad.setDamping(4);
    const echo = frames([quiet, 500], [0.03, 1_000]);
    expect(echo.map(({ level, at }) => vad.step(level, at)).filter(Boolean)).toEqual([]);
    const louder = frames([0.3, 400]).map(({ level, at }) => vad.step(level, at + 2_000));
    expect(louder).toContain("speech-start");
  });
});

describe("a hands-free conversation", () => {
  test("the end of what the person said sends it", () => {
    const { state, effects, words } = run([
      { kind: "start", at: 0 },
      { kind: "speech-start" },
      { kind: "speech-end" },
      { kind: "words", words: " book the 9am train ", at: 3_000 },
    ]);
    expect(effects).toEqual(["record", "transcribe", "send"]);
    expect(words).toBe("book the 9am train");
    expect(state.kind).toBe("thinking");
  });

  test("the reply is spoken, then it listens again", () => {
    const { state } = run([{ kind: "speaking" }, { kind: "turn-over", at: 9_000 }], {
      kind: "thinking",
    });
    expect(state).toEqual({ kind: "listening", since: 9_000 });
  });

  test("talking over the reply stops it at once and is heard", () => {
    const { state, effects } = run([{ kind: "speech-start" }], { kind: "speaking" });
    expect(effects).toEqual(["stop-speaking", "record"]);
    expect(state.kind).toBe("hearing");
  });

  test("nothing made out of a recording sends nothing and listens again", () => {
    const { state, effects } = run([{ kind: "words", words: "  ", at: 5 }], {
      kind: "transcribing",
    });
    expect(effects).toEqual([]);
    expect(state).toEqual({ kind: "listening", since: 5 });
  });

  test("a while with nothing said ends the conversation", () => {
    const { state, effects } = run([
      { kind: "start", at: 0 },
      { kind: "tick", at: 9_000 },
      { kind: "tick", at: 10_000 },
    ]);
    expect(effects).toEqual(["ended-quietly"]);
    expect(state.kind).toBe("off");
  });

  test.each([
    ["hearing", ["discard-recording"]],
    ["speaking", ["stop-speaking"]],
    ["thinking", []],
  ] as const)("ending while %s leaves nothing running", (kind, expected) => {
    const { state, effects } = run([{ kind: "end" }], { kind } as TalkState);
    expect(effects).toEqual(expected);
    expect(state.kind).toBe("off");
  });
});
