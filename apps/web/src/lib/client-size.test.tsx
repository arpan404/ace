import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useClientSize } from "./client-size.ts";

class Observer {
  static resize = () => {};
  constructor(changed: () => void) {
    Observer.resize = changed;
  }
  observe() {}
  disconnect() {}
}
afterEach(() => vi.unstubAllGlobals());

test("equal client-size observations do not render again, while changed dimensions update", () => {
  vi.stubGlobal("ResizeObserver", Observer);
  const element = document.createElement("div");
  let width = 400;
  Object.defineProperties(element, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => 300 },
  });
  const ref = { current: element };
  let renders = 0;
  const view = renderHook(() => {
    renders++;
    return useClientSize(ref);
  });
  expect(view.result.current).toEqual({ width: 400, height: 300 });
  const before = renders;
  act(() => {
    Observer.resize();
    Observer.resize();
  });
  expect(renders).toBe(before);
  width = 420;
  act(() => Observer.resize());
  expect(view.result.current).toEqual({ width: 420, height: 300 });
});
