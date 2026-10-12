import { act, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { createTimeSource, TimeContext } from "@/lib/time.ts";
import { SubagentElapsed } from "./subagent-row.tsx";

test("elapsed labels read the injected clock and freeze at the canonical branch end", () => {
  vi.useFakeTimers();
  let now = 14_000;
  const time = createTimeSource(() => now);
  const label = (running: boolean) => (
    <TimeContext.Provider value={time}>
      <SubagentElapsed startedAt={1_000} endedAt={8_000} running={running} fresh />
    </TimeContext.Provider>
  );
  const view = render(label(true));
  try {
    expect(screen.getByLabelText("Elapsed time").textContent).toBe("13s");
    act(() => {
      now = 15_000;
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByLabelText("Elapsed time").textContent).toBe("14s");
    view.rerender(label(false));
    expect(screen.getByLabelText("Elapsed time").textContent).toBe("7s");
    act(() => {
      now = 90_000;
      vi.advanceTimersByTime(75_000);
    });
    expect(screen.getByLabelText("Elapsed time").textContent).toBe("7s");
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
