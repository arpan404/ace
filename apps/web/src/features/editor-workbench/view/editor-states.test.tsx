import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { CheckoutGone } from "@/features/panels/editor/checkout-gone.tsx";
import { NoFileOpen } from "./editor-states.tsx";

test("an editor with no file open names the keys that open one and search the files", () => {
  const onQuickOpen = vi.fn();
  render(<NoFileOpen onQuickOpen={onQuickOpen} />);
  expect(screen.getByText("No file open")).toBeTruthy();
  screen.getByRole("button", { name: /Open a file/ }).click();
  expect(onQuickOpen).toHaveBeenCalled();
  expect(screen.getByText(/Search files/)).toBeTruthy();
});

test("a checkout whose folder is gone says so with its path and offers no retry", () => {
  render(<CheckoutGone path="/tmp/ace-audit" />);
  expect(screen.getByRole("status").textContent).toContain("This checkout's folder is gone:");
  expect(screen.getByText("/tmp/ace-audit")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});
