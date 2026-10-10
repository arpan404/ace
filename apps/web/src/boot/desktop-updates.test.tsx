import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AppFrame } from "@/app.tsx";
import { StartingScreen } from "@/features/connect/index.ts";

afterEach(() => vi.unstubAllGlobals());

test("Check for Updates reports checking and failure before the connected shell mounts", async () => {
  let report: ((status: unknown) => void) | undefined;
  vi.stubGlobal("ace", {
    updates: {
      onStatus(listener: typeof report) {
        report = listener;
        return () => {};
      },
    },
  });
  render(
    <AppFrame environment={{}}>
      <StartingScreen />
    </AppFrame>,
  );
  act(() => report?.({ state: "checking" }));
  expect(await screen.findByText("Checking for updates…")).toBeTruthy();
  act(() => report?.({ state: "error", message: "Check your connection and try again." }));
  expect((await screen.findByRole("alertdialog")).textContent).toContain(
    "Couldn't check for updates",
  );
  expect(screen.queryByText("Checking for updates…")).toBeNull();
});
