import { act, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useSeconds } from "./time.ts";

let state: DocumentVisibilityState = "visible";
const setVisibility = (next: DocumentVisibilityState) => {
  state = next;
  document.dispatchEvent(new Event("visibilitychange"));
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  state = "visible";
});

test("a live clock stops rendering while the page is hidden and catches up when shown", () => {
  vi.useFakeTimers({ now: Date.parse("2026-10-03T12:00:00Z") });
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
  let renders = 0;
  function Clock() {
    renders++;
    return <span>{new Date(useSeconds(true)).toISOString()}</span>;
  }
  const view = render(<Clock />);
  act(() => vi.advanceTimersByTime(3_000));
  expect(view.container.textContent).toBe("2026-10-03T12:00:03.000Z");
  act(() => setVisibility("hidden"));
  const hiddenAt = renders;
  act(() => vi.advanceTimersByTime(60_000));
  expect(renders).toBe(hiddenAt);
  act(() => setVisibility("visible"));
  expect(view.container.textContent).toBe("2026-10-03T12:01:03.000Z");
  view.unmount();
});
