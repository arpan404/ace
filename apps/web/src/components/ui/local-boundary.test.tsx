import { Suspense } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { LocalBoundary } from "./local-boundary.tsx";
import { ToastProvider } from "./toast.tsx";
import { TooltipProvider } from "./tooltip.tsx";

afterEach(() => vi.restoreAllMocks());

test("retry loads a failed deferred view and preserves its neighbouring draft", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let online = false;
  const view = deferredComponent(async () => {
    if (!online) throw new Error("Chunk unavailable");
    return () => <h2>Recovered dialog</h2>;
  });
  render(
    <TooltipProvider>
      <ToastProvider>
        <input aria-label="Draft" />
        <LocalBoundary label="the dialog" fallback={null}>
          <Suspense fallback={<p>Loading dialog</p>}>
            <view.Component />
          </Suspense>
        </LocalBoundary>
      </ToastProvider>
    </TooltipProvider>,
  );
  await userEvent.type(screen.getByRole("textbox", { name: "Draft" }), "Keep my text");
  const retry = await screen.findByRole("button", { name: "Try again" });
  online = true;
  await userEvent.click(retry);
  expect(await screen.findByRole("heading", { name: "Recovered dialog" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Draft" })).toHaveProperty("value", "Keep my text");
});
