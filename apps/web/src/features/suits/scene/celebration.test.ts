import { expect, test } from "vitest";
import {
  celebrationClip,
  celebrationCue,
  celebrationGapMs,
  createCelebrationGate,
} from "./celebration.ts";
import type { SignalSnapshot } from "./scene-signals.ts";

const snapshot = (
  states: Record<string, string>,
  prs: Record<string, boolean> = {},
): SignalSnapshot => ({
  states: new Map(Object.entries(states)) as SignalSnapshot["states"],
  prs: new Map(Object.entries(prs)),
});

test("the open thread's run finishing is celebrated; another thread finishing isn't", () => {
  const before = snapshot({ open: "working", other: "working" });
  expect(celebrationCue(before, snapshot({ open: "done", other: "working" }), "open")).toBe("done");
  expect(celebrationCue(before, snapshot({ open: "working", other: "done" }), "open")).toBe(
    undefined,
  );
  expect(celebrationCue(before, snapshot({ open: "done", other: "done" }), undefined)).toBe(
    undefined,
  );
});

test("a thread that arrives done, or stays done, is history and not celebrated", () => {
  expect(celebrationCue(snapshot({}), snapshot({ open: "done" }), "open")).toBe(undefined);
  expect(celebrationCue(snapshot({ open: "done" }), snapshot({ open: "done" }), "open")).toBe(
    undefined,
  );
});

test("a pull request merging is celebrated from any thread, and outranks a finish", () => {
  const before = snapshot({ open: "working", other: "done" }, { "pr-1": false });
  const merged = snapshot({ open: "done", other: "done" }, { "pr-1": true });
  expect(celebrationCue(before, merged, "open")).toBe("pr-merged");
  expect(celebrationCue(before, merged, undefined)).toBe("pr-merged");
  // A PR first seen merged is history.
  expect(celebrationCue(snapshot({}), snapshot({}, { "pr-2": true }), undefined)).toBe(undefined);
});

test("a celebration plays at most once every 10 s, never under Reduce motion or out of sight", () => {
  let now = 0;
  const gate = createCelebrationGate({ now: () => now });
  const may = { hasScene: true, reduceMotion: false, visible: true };
  expect(gate.admit({ ...may, reduceMotion: true })).toBe(false);
  expect(gate.admit({ ...may, visible: false })).toBe(false);
  expect(gate.admit({ ...may, hasScene: false })).toBe(false);
  expect(gate.admit(may)).toBe(true);
  now += celebrationGapMs - 1;
  expect(gate.admit(may)).toBe(false);
  now += 1;
  expect(gate.admit(may)).toBe(true);
});

test("the layer's clip cuts a hole around each protected part, merging holes that touch", () => {
  const view = { width: 1000, height: 600 };
  expect(celebrationClip([], view)).toBe("none");
  expect(celebrationClip([{ left: 100, top: 500, width: 300, height: 40 }], view, 6)).toBe(
    'path(evenodd, "M0 0H1000V600H0ZM94 494H406V546H94Z")',
  );
  // Two parts 4 px apart: one hole, so the scene never shows in the gap between them.
  expect(
    celebrationClip(
      [
        { left: 100, top: 100, width: 50, height: 20 },
        { left: 100, top: 124, width: 50, height: 20 },
      ],
      view,
      6,
    ),
  ).toBe('path(evenodd, "M0 0H1000V600H0ZM94 94H156V150H94Z")');
  // A part off screen or with no size cuts nothing; one at the edge is held to the window.
  expect(celebrationClip([{ left: -500, top: 0, width: 100, height: 10 }], view, 6)).toBe("none");
  expect(celebrationClip([{ left: 0, top: 0, width: 0, height: 10 }], view, 6)).toBe("none");
  expect(celebrationClip([{ left: 990, top: 590, width: 40, height: 40 }], view, 6)).toBe(
    'path(evenodd, "M0 0H1000V600H0ZM984 584H1000V600H984Z")',
  );
});
