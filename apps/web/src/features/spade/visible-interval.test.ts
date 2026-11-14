import { expect, test } from "vitest";
import type { PageVisibility } from "@/lib/page-visibility.ts";
import { visibleInterval, type Repeat } from "./visible-interval.ts";

/** A page that tests hide and show, and a clock whose ticks they fire by hand. */
function page() {
  let visible = true;
  const watchers = new Set<() => void>();
  const visibility: PageVisibility = {
    visible: () => visible,
    watch(changed) {
      watchers.add(changed);
      return () => watchers.delete(changed);
    },
  };
  const running = new Set<() => void>();
  const repeat: Repeat = (callback) => {
    running.add(callback);
    return () => running.delete(callback);
  };
  return {
    visibility,
    repeat,
    tick: () => [...running].forEach((callback) => callback()),
    set(next: boolean) {
      visible = next;
      watchers.forEach((changed) => changed());
    },
  };
}

test("a look repeats only while the page is shown, and catches up as soon as it is shown again", () => {
  const screen = page();
  let looks = 0;
  const stop = visibleInterval(() => looks++, 10_000, screen.visibility, screen.repeat);
  screen.tick();
  expect(looks).toBe(1);

  screen.set(false);
  screen.tick();
  screen.tick();
  expect(looks).toBe(1);

  screen.set(true);
  expect(looks).toBe(2);
  screen.tick();
  expect(looks).toBe(3);

  stop();
  screen.tick();
  expect(looks).toBe(3);
});

test("a page hidden from the start looks only once it is shown", () => {
  const screen = page();
  screen.set(false);
  let looks = 0;
  visibleInterval(() => looks++, 60_000, screen.visibility, screen.repeat);
  screen.tick();
  expect(looks).toBe(0);
  screen.set(true);
  expect(looks).toBe(1);
});
