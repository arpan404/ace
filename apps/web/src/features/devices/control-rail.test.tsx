import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { createTimeSource, TimeContext } from "@/lib/time.ts";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { ControlRail } from "./control-rail.tsx";

const scope = createRef<HTMLElement>();
const noop = () => {};
afterEach(() => vi.useRealTimers());

test("recording time starts fresh for each recording and catches up after the page was hidden", () => {
  vi.useFakeTimers({ now: 10_000 });
  const time = createTimeSource(() => Date.now());
  const rail = (recording: boolean) => (
    <TimeContext value={time}>
      <TooltipProvider>
        <ControlRail
          scope={scope}
          android={false}
          live
          pending={false}
          recording={recording}
          keyboardOpen={false}
          onKey={noop}
          onKeyboard={noop}
          onScreenshot={noop}
          onRecord={noop}
        />
      </TooltipProvider>
    </TimeContext>
  );
  const view = render(rail(true));
  expect(screen.getByRole("timer").textContent).toBe("0s");
  act(() => vi.advanceTimersByTime(3_000));
  expect(screen.getByRole("timer").textContent).toBe("3s");
  view.rerender(rail(false));
  expect(screen.queryByRole("timer")).toBeNull();
  act(() => vi.advanceTimersByTime(60_000));
  view.rerender(rail(true));
  expect(screen.getByRole("timer").textContent).toBe("0s");
  act(() => vi.advanceTimersByTime(2_000));
  expect(screen.getByRole("timer").textContent).toBe("2s");
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  act(() => vi.advanceTimersByTime(10_000));
  expect(screen.getByRole("timer").textContent).toBe("2s");
  visibility.mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(screen.getByRole("timer").textContent).toBe("12s");
  visibility.mockRestore();
  view.unmount();
});
