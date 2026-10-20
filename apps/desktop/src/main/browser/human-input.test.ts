import { expect, it } from "vitest";
import { HumanInputReports } from "./human-input.ts";

function reports() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let id = 0;
  const times: number[] = [];
  const human = new HumanInputReports(
    {
      now: () => now,
      set: (delayMs, run) => {
        const key = ++id;
        timers.set(key, { at: now + delayMs, run });
        return () => timers.delete(key);
      },
    },
    () => times.push(now),
  );
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers.entries()].toSorted((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].run();
    }
    now = end;
  };
  return { human, times, advance };
}

it("pointer moves, key ups and IME composition count as the person using the page", () => {
  const { human, times, advance } = reports();
  human.mouse("mouseMove");
  advance(300);
  human.key();
  advance(300);
  human.mouse("mouseWheel");
  expect(times).toEqual([0, 300, 600]);
});

it("reports at most every 250 ms however much the person does", () => {
  const { human, times, advance } = reports();
  for (let step = 0; step < 10; step++) {
    human.mouse("mouseMove");
    advance(50);
  }
  expect(times).toEqual([0, 250]);
});

it("a held button keeps counting until released, even with no events in between", () => {
  const { human, times, advance } = reports();
  human.mouse("mouseDown", ["leftbuttondown"]);
  // A native drag-and-drop: the view sees nothing for two seconds.
  advance(2_000);
  expect(times.length).toBeGreaterThanOrEqual(8);
  expect(times.at(-1)).toBeGreaterThanOrEqual(1_750);
  human.mouse("mouseUp");
  const released = times.length;
  advance(2_000);
  expect(times.length).toBe(released);
});

it("a button release lost to a native drag stops counting after a pointer move without buttons", () => {
  const { human, times, advance } = reports();
  human.mouse("mouseDown", ["leftbuttondown"]);
  advance(500);
  human.mouse("mouseMove", []);
  const moved = times.length;
  advance(2_000);
  expect(times.length).toBe(moved);
});

it("a held button with no events at all stops counting after thirty seconds", () => {
  const { human, times, advance } = reports();
  human.mouse("mouseDown", ["leftbuttondown"]);
  advance(30_000);
  const held = times.length;
  advance(5_000);
  expect(times.length).toBe(held);
  expect(times.at(-1)).toBeLessThanOrEqual(30_000);
});
