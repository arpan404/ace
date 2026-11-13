import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AgentCursor } from "./agent-cursor.tsx";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

const draw = (at: number, x = 240, y = 150) => (
  <AgentCursor
    pointer={{ x, y, kind: "click", at }}
    width={960}
    height={600}
    name="Scout"
    mark="S"
  />
);

test("the agent's pointer shows at the point it reported and fades 1.5 s after its last action", () => {
  const { rerender } = render(draw(Date.now()));
  act(() => vi.advanceTimersByTime(0));
  const pointer = screen.getByRole("img", { name: "Scout's pointer" });
  // 240 of 960 across, 150 of 600 down.
  expect(pointer.style.left).toBe("25%");
  expect(pointer.style.top).toBe("25%");

  act(() => vi.advanceTimersByTime(1390));
  expect(screen.getByRole("img", { name: "Scout's pointer" })).toBeTruthy();
  act(() => vi.advanceTimersByTime(120));
  expect(screen.queryByRole("img", { name: "Scout's pointer" })).toBeNull();

  // A new action brings it back, where it acted this time.
  rerender(draw(Date.now(), 480, 300));
  act(() => vi.advanceTimersByTime(0));
  expect(screen.getByRole("img", { name: "Scout's pointer" }).style.left).toBe("50%");
});

test("a pointer from an action long past never shows", () => {
  render(draw(Date.now() - 5000));
  act(() => vi.advanceTimersByTime(10));
  expect(screen.queryByRole("img", { name: "Scout's pointer" })).toBeNull();
});
