import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "./tooltip.tsx";
import { afterEach, expect, test, vi } from "vitest";
import { ToastProvider, useToast } from "./toast.tsx";

afterEach(() => {
  vi.useRealTimers();
});

function Buttons() {
  const toast = useToast();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          toast.add({ title: "Signed in to Codex · Work", kind: "provider-auth", eventId: "work" });
          toast.add({ title: "Signed in to Codex · Work", kind: "provider-auth", eventId: "work" });
          toast.add({
            title: "Signed in to Codex · Personal",
            kind: "provider-auth",
            eventId: "personal",
          });
        }}
      >
        Sign in twice
      </button>
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
        onClick={() => {
          for (const name of ["first", "second"])
            toast.add({
              title: "Archived",
              actionProps: {
                children: "Undo",
                onClick: () => toast.add({ title: `Restored ${name}` }),
              },
            });
        }}
      >
        Archive twice
      </button>
      <button
        type="button"
        onClick={() => toast.error({ title: "Couldn't archive", description: "Offline." })}
      >
        Fail
      </button>
      <button
        type="button"
        onClick={() => {
          for (const name of ["one", "two", "three", "four"])
            toast.add({ title: `Archived ${name}`, actionProps: { children: "Undo" } });
        }}
      >
        Archive four
      </button>
      <button
        type="button"
        onClick={() =>
          toast.error({
            title: "Couldn't save",
            actionProps: { children: "Retry", onClick: () => toast.add({ title: "Saved" }) },
          })
        }
      >
        Fail with retry
      </button>
    </>
  );
}

const setup = () =>
  render(
    <TooltipProvider delay={0}>
      <ToastProvider>
        <Buttons />
      </ToastProvider>
    </TooltipProvider>,
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
  await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
  await vi.waitFor(() => expect(screen.queryByText("Archived")).toBeNull());
});

test("a plain toast goes after 4 s and one with an action after 8 s, not before", async () => {
  vi.useFakeTimers();
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  await act(() => vi.advanceTimersByTimeAsync(3_999));
  expect(screen.getByText("Copied")).toBeTruthy();
  // Closed at 4 s; the exit takes at most a few frames.
  await act(() => vi.advanceTimersByTimeAsync(51));
  expect(screen.queryByText("Copied")).toBeNull();
  expect(screen.getByText("Archived")).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(7_999 - 4_050));
  expect(screen.getByText("Archived")).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(51));
  expect(screen.queryByText("Archived")).toBeNull();
});

test("an Undo waiting behind a full stack keeps its whole time for when it shows", async () => {
  vi.useFakeTimers();
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Archive four" }));
  await act(() => vi.advanceTimersByTimeAsync(8_050));
  // The three shown ran out at 8 s; the one that waited shows now, with its 8 s ahead.
  expect(screen.queryByText("Archived two")).toBeNull();
  expect(screen.getByText("Archived one")).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(7_900));
  expect(screen.getByText("Archived one")).toBeTruthy();
});

test("an error toast's Retry and Dismiss can be found by role and used", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: "Fail with retry" }));
  const card = await screen.findByRole("alertdialog");
  await userEvent.click(within(card).getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Saved")).toBeTruthy();
  expect(within(card).getByRole("button", { name: "Dismiss", hidden: false })).toBeTruthy();
});

test("a repeated sign-in event announces once and a newer sign-in replaces its wording", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: "Sign in twice" }));
  expect(await screen.findByText("Signed in to Codex · Personal")).toBeTruthy();
  expect(screen.queryByText("Signed in to Codex · Work")).toBeNull();
  expect(screen.getAllByRole("button", { name: "Dismiss" })).toHaveLength(1);
});

test("a newer confirmation of the same kind replaces its action too", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: "Archive twice" }));
  expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(await screen.findByText("Restored second")).toBeTruthy();
  expect(screen.queryByText("Restored first")).toBeNull();
});
