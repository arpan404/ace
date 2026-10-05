import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ToastProvider, useToast } from "./toast.tsx";

afterEach(() => {
  vi.useRealTimers();
});

function Buttons() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.add({ title: "Copied" })}>
        Copy
      </button>
      <button
        type="button"
        onClick={() =>
          toast.add({ title: "Archived", actionProps: { children: "Undo", onClick: () => {} } })
        }
      >
        Archive
      </button>
      <button
        type="button"
        onClick={() => toast.error({ title: "Couldn't archive", description: "Offline." })}
      >
        Fail
      </button>
    </>
  );
}

const setup = () =>
  render(
    <ToastProvider>
      <Buttons />
    </ToastProvider>,
  );

test("an error toast is announced at once, apart from plain confirmations", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: "Copy" }));
  await userEvent.click(screen.getByRole("button", { name: "Fail" }));
  // Base UI announces high-priority toasts through an assertive live region.
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Couldn't archiveOffline.");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});

test("every toast has a Dismiss button that closes it", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: "Archive" }));
  // Hovering the stack (or F6) expands it; then its controls can be reached.
  await userEvent.hover(await screen.findByText("Archived"));
  await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
  await vi.waitFor(() => expect(screen.queryByText("Archived")).toBeNull());
});

test("a toast with an action stays twice as long as a plain one", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setup();
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await user.click(screen.getByRole("button", { name: "Copy" }));
  await user.click(screen.getByRole("button", { name: "Archive" }));
  await user.unhover(screen.getByRole("button", { name: "Archive" }));
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(screen.queryByText("Copied")).toBeNull();
  expect(screen.getByText("Archived")).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(4_000));
  expect(screen.queryByText("Archived")).toBeNull();
});
