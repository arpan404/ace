import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AppFrame } from "@/app.tsx";
import { StartupPending } from "@/features/startup/index.ts";

afterEach(() => vi.unstubAllGlobals());

const releaseUrl = "https://github.com/arpan404/ace/releases/tag/v1.1.0";
const status = (overrides: Record<string, unknown>) => ({
  state: "idle",
  currentVersion: "1.0.0",
  version: null,
  releaseUrl: null,
  inPlace: true,
  percent: null,
  waiting: 0,
  notes: [],
  olderReleases: 0,
  error: null,
  ...overrides,
});

/** The desktop preload's update events, before the connected shell mounts. */
function desktop() {
  let report: ((value: unknown) => void) | undefined;
  let checked: ((value: unknown) => void) | undefined;
  vi.stubGlobal("ace", {
    updates: {
      onStatus(listener: typeof report) {
        report = listener;
        return () => {};
      },
      onChecked(listener: typeof checked) {
        checked = listener;
        return () => {};
      },
    },
  });
  render(
    <AppFrame environment={{}}>
      <StartupPending />
    </AppFrame>,
  );
  return {
    report: (value: unknown) => act(() => report?.(value)),
    checked: (value: unknown) => act(() => checked?.(value)),
  };
}

test("Check for Updates in the menu answers with what it found", async () => {
  const app = desktop();
  app.checked(status({ state: "current" }));
  expect(await screen.findByText("ace is up to date (1.0.0)")).toBeTruthy();
  app.checked(status({ state: "error", error: { during: "check", message: "Offline" } }));
  expect((await screen.findByRole("alertdialog")).textContent).toContain(
    "Couldn't check for updates",
  );
});

test("a finished download says how to install it; background progress stays quiet", async () => {
  const app = desktop();
  const offer = { version: "1.1.0", releaseUrl };
  app.report(status({ ...offer, state: "available" }));
  app.report(status({ ...offer, state: "downloading", percent: 10 }));
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(screen.queryByText(/1\.1\.0|Update downloaded/)).toBeNull();
  app.report(status({ ...offer, state: "downloaded", percent: 100 }));
  expect(await screen.findByText("Update downloaded")).toBeTruthy();
  expect(screen.getByText("Restart ace from the update button to install it.")).toBeTruthy();
});

test("a Restart that found agents still working says so", async () => {
  const app = desktop();
  const offer = { version: "1.1.0", releaseUrl };
  app.report(status({ ...offer, state: "installing", waiting: 1 }));
  app.report(
    status({
      ...offer,
      state: "downloaded",
      error: {
        during: "install",
        message: "Agents are still working. Restart again once they finish.",
      },
    }),
  );
  expect(await screen.findByText("Agents are still working")).toBeTruthy();
});
