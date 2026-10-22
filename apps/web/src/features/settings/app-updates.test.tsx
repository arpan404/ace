import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

/** The desktop preload's update status, with anything a case changes. */
function status(overrides: Record<string, unknown> = {}) {
  return {
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
  };
}
const offer = (overrides: Record<string, unknown> = {}) =>
  status({ state: "available", version: "1.1.0", ...overrides });

/**
 * The desktop's preload bridge: settings as stored, and an updater whose `check` reports what
 * the feed found, as the main process does.
 */
function desktop(initial: unknown, found: unknown = status({ state: "current" })) {
  let report: ((value: unknown) => void) | undefined;
  const calls: string[] = [];
  const stored = {
    background: true,
    openAtLogin: false,
    preventSleep: false,
    attention: true,
    globalShortcut: null,
    notifications: { enabled: true, categories: {}, quietHours: null },
  };
  vi.stubGlobal("ace", {
    settings: {
      get: async () => stored,
      update: async () => stored,
      onChange: () => () => {},
    },
    updates: {
      current: async () => initial,
      check: async () => {
        calls.push("check");
        report?.(found);
        return found;
      },
      download: async () => {
        calls.push("download");
        return initial;
      },
      install: async () => {
        calls.push("install");
        return initial;
      },
      busy: async () => 0,
      onStatus(listener: (value: unknown) => void) {
        report = listener;
        return () => {};
      },
    },
  });
  return { calls, report: (value: unknown) => act(() => report?.(value)) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("Settings checks for updates on request and shows a found update ready to download", async () => {
  const machine = desktop(status(), offer());
  await harness().open("/settings/general");
  expect(await screen.findByText("You have ace 1.0.0.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(machine.calls).toEqual(["check"]);
  expect(await screen.findByText("ace 1.1.0 is available.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Download" }));
  expect(machine.calls).toEqual(["check", "download"]);
  machine.report(offer({ state: "downloading", percent: 42.6 }));
  expect(screen.getByText("Downloading ace 1.1.0 (42%).")).toBeTruthy();
});

test("an update a background check found shows in Settings without a manual check", async () => {
  const machine = desktop(status());
  await harness().open("/settings/general");
  await screen.findByText("You have ace 1.0.0.");
  machine.report(offer());
  expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  expect(machine.calls).toEqual([]);
});

test("a downloaded update restarts from Settings only after the person confirms", async () => {
  const machine = desktop(offer({ state: "downloaded", percent: 100 }));
  await harness().open("/settings/general");
  await userEvent.click(await screen.findByRole("button", { name: "Restart to update" }));
  expect(await screen.findByText("Nothing is running. ace is back in a few seconds.")).toBeTruthy();
  expect(machine.calls).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "Restart" }));
  expect(machine.calls).toEqual(["install"]);
});

test("a browser shows no Updates row in Settings", async () => {
  await harness().open("/settings/general");
  await screen.findByText("Your name");
  expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
});
