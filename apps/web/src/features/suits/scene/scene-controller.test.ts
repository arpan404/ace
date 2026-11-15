import type { SceneHostMessage } from "@ace/protocol/suits";
import { expect, test } from "vitest";
import {
  createSceneController,
  messageFromScene,
  type SceneStart,
  type SceneStop,
} from "./scene-controller.ts";

/** A clock and timers that move only when the test says so. */
function manualTime() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    clock: { now: () => now },
    scheduler: {
      after(ms: number, run: () => void) {
        const id = next++;
        timers.set(id, { at: now + ms, run });
        return () => void timers.delete(id);
      },
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let due: [number, { at: number; run: () => void }] | undefined;
        for (const entry of timers)
          if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        timers.delete(due[0]);
        // An overdue timer (after a `stall`) runs late, at the time it gets to run.
        now = Math.max(now, due[1].at);
        due[1].run();
      }
      now = end;
    },
    /** The page's thread is busy for `ms`: time passes and no timer runs until it is free. */
    stall(ms: number) {
      now += ms;
    },
  };
}

const start: SceneStart = {
  scheme: "dark",
  width: 1280,
  height: 800,
  pixelRatio: 2,
  reduceMotion: false,
  visible: true,
  focused: true,
  lowPower: false,
};

function scene(overrides: Partial<SceneStart> = {}) {
  const time = manualTime();
  const sent: SceneHostMessage[] = [];
  const stops: SceneStop[] = [];
  const controller = createSceneController(
    { ...start, ...overrides },
    {
      clock: time.clock,
      scheduler: time.scheduler,
      post: (message) => sent.push(message),
      stopped: (stop) => stops.push(stop),
    },
  );
  const ticks = () => sent.filter((message) => message.type === "tick");
  /** Answers every tick sent so far that has no answer yet, as a prompt scene would. */
  let answered = 0;
  const draw = () => {
    for (const tick of ticks().slice(answered))
      if (tick.type === "tick") controller.receive({ type: "drawn", time: tick.time });
    answered = ticks().length;
  };
  /** Lets `ms` pass with a scene that answers every tick within 10 ms. */
  const play = (ms: number) => {
    for (let passed = 0; passed < ms; passed += 10) {
      time.advance(10);
      draw();
    }
  };
  const types = () => sent.map((message) => message.type);
  return { controller, time, sent, stops, ticks, draw, play, types };
}

test("init carries the scheme, size and motion setting, and ticks wait for ready", () => {
  const { controller, sent, ticks, time } = scene();
  controller.start();
  expect(sent).toEqual([
    { type: "init", scheme: "dark", width: 1280, height: 800, pixelRatio: 2, reduceMotion: false },
  ]);
  time.advance(500);
  expect(ticks()).toEqual([]);
});

test("a ready scene gets at most 30 ticks a second, each only after the last was drawn", () => {
  const { controller, ticks, play } = scene();
  controller.start();
  controller.receive({ type: "ready" });
  play(1000);
  // 1 s of a prompt scene: 30 or 31 ticks counting the first one at 0 ms.
  expect(ticks().length).toBeGreaterThanOrEqual(30);
  expect(ticks().length).toBeLessThanOrEqual(31);
});

test("a scene that has not answered its last tick gets no new one", () => {
  const { controller, time, ticks } = scene();
  controller.start();
  controller.receive({ type: "ready" });
  time.advance(90);
  expect(ticks()).toHaveLength(1);
});

test("hiding the page pauses the scene and showing it resumes from the same scene time", () => {
  const { controller, time, ticks, draw, types, sent } = scene();
  controller.start();
  controller.receive({ type: "ready" });
  time.advance(100);
  draw();
  const before = ticks().length;
  controller.setVisible(false);
  expect(types().at(-1)).toBe("pause");
  time.advance(60_000);
  expect(ticks()).toHaveLength(before);
  controller.setVisible(true);
  expect(types().at(-1)).toBe("resume");
  time.advance(40);
  const last = sent.at(-1);
  expect(last?.type).toBe("tick");
  // The minute it spent hidden is not scene time.
  expect(last?.type === "tick" && last.time).toBeLessThan(1000);
});

test("a window blurred for 10 s pauses the scene; a shorter blur does not", () => {
  const { controller, types, play } = scene();
  controller.start();
  controller.receive({ type: "ready" });
  controller.setFocused(false);
  play(9_000);
  controller.setFocused(true);
  play(9_000);
  expect(types()).not.toContain("pause");
  controller.setFocused(false);
  play(10_000);
  expect(types().at(-1)).toBe("pause");
  controller.setFocused(true);
  expect(types().at(-1)).toBe("resume");
});

test("battery saver pauses the scene until it ends", () => {
  const { controller, time, ticks, types, draw } = scene();
  controller.start();
  controller.receive({ type: "ready" });
  draw();
  controller.setLowPower(true);
  const before = ticks().length;
  time.advance(5_000);
  expect(ticks()).toHaveLength(before);
  expect(types().at(-1)).toBe("pause");
  controller.setLowPower(false);
  time.advance(40);
  expect(ticks().length).toBeGreaterThan(before);
});

test("under Reduce motion the scene draws one still frame and then pauses", () => {
  const { controller, time, types } = scene({ reduceMotion: true });
  controller.start();
  controller.receive({ type: "ready" });
  time.advance(5_000);
  expect(types()).toEqual(["init", "tick", "pause"]);
});

test("under Reduce motion a scheme change or resize redraws the still frame", () => {
  const { controller, types, draw } = scene({ reduceMotion: true });
  controller.start();
  controller.receive({ type: "ready" });
  draw();
  controller.setScheme("light");
  draw();
  controller.resize({ width: 900, height: 700, pixelRatio: 2 });
  expect(types()).toEqual(["init", "tick", "pause", "scheme", "tick", "resize", "tick"]);
});

test("turning Reduce motion on stops the motion and off starts it again", () => {
  const { controller, time, ticks, sent, draw } = scene();
  controller.start();
  controller.receive({ type: "ready" });
  draw();
  controller.setReduceMotion(true);
  expect(sent.slice(-3).map((message) => message.type)).toEqual(["motion", "pause", "tick"]);
  draw();
  const still = ticks().length;
  time.advance(2_000);
  expect(ticks()).toHaveLength(still);
  controller.setReduceMotion(false);
  time.advance(40);
  expect(ticks().length).toBeGreaterThan(still);
});

test("a scene that is not ready within 3 s is stopped", () => {
  const { controller, time, stops } = scene();
  controller.start();
  time.advance(2_999);
  expect(stops).toEqual([]);
  time.advance(1);
  expect(stops).toEqual([{ reason: "no-ready" }]);
  // A late ready changes nothing.
  controller.receive({ type: "ready" });
  time.advance(1_000);
  expect(stops).toHaveLength(1);
});

test("an error from the scene stops it, with its words", () => {
  const { controller, stops, time, ticks } = scene();
  controller.start();
  controller.receive({ type: "ready" });
  controller.receive({ type: "error", message: "WebGL context lost" });
  expect(stops).toEqual([{ reason: "error", message: "WebGL context lost" }]);
  const sent = ticks().length;
  time.advance(1_000);
  expect(ticks()).toHaveLength(sent);
});

test("three frames drawn more than 100 ms after their tick stop the scene", () => {
  const { controller, time, ticks, stops } = scene();
  controller.start();
  controller.receive({ type: "ready" });
  let seen = 0;
  const answerLate = () => {
    while (ticks().length === seen) time.advance(1);
    seen = ticks().length;
    const tick = ticks().at(-1);
    time.advance(101);
    if (tick?.type === "tick") controller.receive({ type: "drawn", time: tick.time });
  };
  answerLate();
  answerLate();
  expect(stops).toEqual([]);
  answerLate();
  expect(stops).toEqual([{ reason: "slow" }]);
});

test("a busy page holding back an answer now and then never stops the scene", () => {
  // A long transcript rendering blocks the page's thread: the answer and the next timer wait.
  const { controller, time, ticks, stops, play } = scene();
  controller.start();
  controller.receive({ type: "ready" });
  for (let stall = 0; stall < 6; stall++) {
    play(100);
    // A tick goes out, then the page blocks before its answer is handled.
    const seen = ticks().length;
    for (let waited = 0; waited < 100 && ticks().length === seen; waited++) time.advance(1);
    const tick = ticks().at(-1);
    time.stall(400);
    // The page frees up: sometimes the answer is handled first, sometimes the next timer.
    if (stall % 2 === 1) time.advance(1);
    if (tick?.type === "tick") controller.receive({ type: "drawn", time: tick.time });
  }
  play(200);
  expect(stops).toEqual([]);
});

test("a scene that stops answering ticks is stopped as slow", () => {
  const { controller, time, stops } = scene();
  controller.start();
  controller.receive({ type: "ready" });
  time.advance(1_000);
  expect(stops).toEqual([{ reason: "slow" }]);
});

test("quick frames never stop the scene", () => {
  const { controller, play, stops } = scene();
  controller.start();
  controller.receive({ type: "ready" });
  play(10_000);
  expect(stops).toEqual([]);
});

test("signals are forwarded only to a ready scene", () => {
  const { controller, sent } = scene();
  controller.start();
  controller.signal("working");
  controller.receive({ type: "ready" });
  controller.signal("pr-merged");
  expect(sent.filter((message) => message.type === "signal")).toEqual([
    { type: "signal", signal: "pr-merged" },
  ]);
});

test("only valid messages from the scene's own frame are accepted", () => {
  const frame = {};
  expect(messageFromScene({ source: frame, data: { type: "ready" } }, frame)).toEqual({
    type: "ready",
  });
  expect(messageFromScene({ source: {}, data: { type: "ready" } }, frame)).toBeUndefined();
  expect(messageFromScene({ source: frame, data: { type: "drawn" } }, frame)).toBeUndefined();
  expect(messageFromScene({ source: frame, data: "ready" }, frame)).toBeUndefined();
  expect(messageFromScene({ source: null, data: { type: "ready" } }, null)).toBeUndefined();
});

test("a celebration is told its region, hears what woke it once ready, and may say it's done", () => {
  const time = manualTime();
  const sent: SceneHostMessage[] = [];
  let finished = 0;
  const controller = createSceneController(
    { ...start, region: "celebration", wake: "pr-merged" },
    {
      clock: time.clock,
      scheduler: time.scheduler,
      post: (message) => sent.push(message),
      stopped: () => {},
      finished: () => (finished += 1),
    },
  );
  controller.start();
  expect(sent).toEqual([expect.objectContaining({ type: "init", region: "celebration" })]);
  // Finishing before it's ready isn't a celebration that played out.
  controller.receive({ type: "finished" });
  expect(finished).toBe(0);
  controller.receive({ type: "ready" });
  expect(sent[1]).toEqual({ type: "signal", signal: "pr-merged" });
  controller.receive({ type: "finished" });
  expect(finished).toBe(1);
});
