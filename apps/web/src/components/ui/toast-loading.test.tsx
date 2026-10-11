import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ToastProvider, useToast } from "./toast.tsx";

const loading = vi.hoisted(() => {
  let release: (() => void) | undefined;
  let loaded: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  return { gate, done, release: () => release?.(), loaded: () => loaded?.() };
});
vi.mock("./toast-view.tsx", async (original) => {
  await loading.gate;
  const view = await original();
  loading.loaded();
  return view;
});
afterEach(() => vi.useRealTimers());

function Confirm() {
  const toast = useToast();
  return (
    <button
      onClick={() => {
        toast.add({ title: "Copied" });
        toast.add({ title: "Archived", actionProps: { children: "Undo" } });
      }}
    >
      Confirm
    </button>
  );
}

test("confirmations and Undo keep their full reading time while notification code loads", async () => {
  vi.useFakeTimers();
  render(
    <ToastProvider>
      <Confirm />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  await act(async () => {
    loading.release();
    await loading.done;
  });
  expect(screen.getByText("Copied")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(4_999));
  expect(screen.getByText("Copied")).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(51));
  expect(screen.queryByText("Copied")).toBeNull();
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(7_999 - 5_050));
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(51));
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});
