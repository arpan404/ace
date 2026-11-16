import type { SceneHostMessage } from "@ace/protocol/suits";
import { expect, test } from "vitest";
import { createSceneBeat } from "./scene-beat.ts";
import { createSceneController, type SceneStart, type SceneStop } from "./scene-controller.ts";

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
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
  };
}

const start: SceneStart = {
  scheme: "dark",
  width: 300,
  height: 800,
  pixelRatio: 2,
  reduceMotion: false,
  visible: true,
  focused: true,
  lowPower: false,
};

/** Scenes on one shared beat, each answering every tick at once, as a quick scene would. */
function page(count: number) {
  const time = manualTime();
  const frames = createSceneBeat(time);
  const scenes = Array.from({ length: count }, () => {
    const sent: SceneHostMessage[] = [];
    const stops: SceneStop[] = [];
    const controller = createSceneController(start, {
      clock: time.clock,
      scheduler: time.scheduler,
      frames,
      post: (message) => {
        sent.push(message);
        if (message.type === "tick")
          queueMicrotask(() => controller.receive({ type: "drawn", time: message.time }));
      },
      stopped: (stop) => stops.push(stop),
    });
    return { controller, sent, stops, ticks: () => sent.filter((m) => m.type === "tick").length };
  });
  for (const scene of scenes) {
    scene.controller.start();
    scene.controller.receive({ type: "ready" });
  }
  const play = async (ms: number) => {
    for (let passed = 0; passed < ms; passed += 5) {
      time.advance(5);
      await Promise.resolve();
    }
  };
  return { scenes, play };
}

test("three region scenes share 30 frames a second between them and take turns", async () => {
  const { scenes, play } = page(3);
  await play(1000);
  const ticks = scenes.map((scene) => scene.ticks());
  expect(ticks.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(31);
  expect(ticks.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(28);
  for (const count of ticks) expect(count).toBeGreaterThanOrEqual(9);
  // Taking turns is not lateness: nobody is stopped for waiting on the others.
  expect(scenes.flatMap((scene) => scene.stops)).toEqual([]);
});

test("one scene alone on the beat keeps the full 30 frames", async () => {
  const { scenes, play } = page(1);
  await play(1000);
  expect(scenes[0]?.ticks()).toBeGreaterThanOrEqual(29);
});

test("a paused scene gives its turns to the others; its watchdog stays its own", async () => {
  const { scenes, play } = page(2);
  const [paused, running] = scenes;
  paused?.controller.setVisible(false);
  await play(1000);
  expect(paused?.ticks()).toBe(0);
  expect(running?.ticks()).toBeGreaterThanOrEqual(29);
  paused?.controller.receive({ type: "error", message: "boom" });
  expect(paused?.stops).toEqual([{ reason: "error", message: "boom" }]);
  expect(running?.stops).toEqual([]);
});
