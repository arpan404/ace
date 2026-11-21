import { expect, it } from "vitest";
import { droppedLineNotes } from "./dropped-line-notes.ts";

function timers() {
  const pending = new Map<() => void, number>();
  return {
    schedule(run: () => void, ms: number) {
      pending.set(run, ms);
      return () => void pending.delete(run);
    },
    fire() {
      const runs = [...pending.keys()];
      pending.clear();
      for (const run of runs) run();
    },
    pending: () => [...pending.values()],
  };
}
const line = (bytes: number, phase: "start" | "end" | "complete" = "complete") => ({
  bytes,
  prefix: "",
  phase,
});

it("a flood of dropped lines gives one note at once, then one summary per interval", () => {
  const clock = timers();
  const notes: string[] = [];
  const drops = droppedLineNotes({ note: (text) => notes.push(text), schedule: clock.schedule });
  for (let i = 0; i < 1000; i++) drops.dropped(line(100));
  expect(notes).toEqual(["ace dropped a stderr line of 100 bytes"]);
  expect(clock.pending()).toEqual([1000]);
  clock.fire();
  expect(notes.at(-1)).toBe("ace dropped 999 stderr lines, 99900 bytes in total");
  clock.fire();
  // A quiet interval closes the window; the next drop is noted at once again.
  expect(notes).toHaveLength(2);
  expect(clock.pending()).toEqual([]);
  drops.dropped(line(7));
  expect(notes.at(-1)).toBe("ace dropped a stderr line of 7 bytes");
});

it("a split line counts once, at its final size", () => {
  const clock = timers();
  const notes: string[] = [];
  const drops = droppedLineNotes({ note: (text) => notes.push(text), schedule: clock.schedule });
  drops.dropped(line(10, "start"));
  drops.dropped(line(50, "end"));
  expect(notes).toEqual(["ace dropped a stderr line of 50 bytes"]);
});

it("flush reports what is still pending and stops the timer", () => {
  const clock = timers();
  const notes: string[] = [];
  const drops = droppedLineNotes({ note: (text) => notes.push(text), schedule: clock.schedule });
  drops.dropped(line(1));
  drops.dropped(line(2));
  drops.dropped(line(3));
  drops.flush();
  expect(notes).toEqual([
    "ace dropped a stderr line of 1 bytes",
    "ace dropped 2 stderr lines, 5 bytes in total",
  ]);
  expect(clock.pending()).toEqual([]);
  drops.flush();
  expect(notes).toHaveLength(2);
});
