import { cleanup, screen, waitFor } from "@testing-library/react";
import { facts } from "@ace/fake-daemon";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

interface Stored {
  background: boolean;
  openAtLogin: boolean;
  preventSleep: boolean;
  attention: boolean;
  globalShortcut: string | null;
  notifications: {
    enabled: boolean;
    categories: Record<string, boolean>;
    quietHours: { start: number; end: number } | null;
  };
}

/**
 * The desktop's preload bridge as the page sees it: `settings.update` replaces whole top-level
 * fields, stores them and announces the result, as the main process does before applying it.
 */
function desktop() {
  let stored: Stored = {
    background: true,
    openAtLogin: false,
    preventSleep: false,
    attention: true,
    globalShortcut: null,
    notifications: { enabled: true, categories: {}, quietHours: null },
  };
  const listeners = new Set<(value: Stored) => void>();
  vi.stubGlobal("ace", {
    settings: {
      get: async () => stored,
      update: async (patch: Partial<Stored>) => {
        stored = { ...stored, ...patch };
        for (const listener of listeners) listener(stored);
        return stored;
      },
      onChange: (listener: (value: Stored) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  return { stored: () => stored };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("in the desktop app, Open ace at login turns on the desktop's own login item", async () => {
  const machine = desktop();
  const app = harness();
  await app.open("/settings/general");
  const toggle = await screen.findByRole("switch", { name: "Open ace at login" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  await userEvent.click(toggle);

  await waitFor(() => expect(machine.stored().openAtLogin).toBe(true));
  expect(
    (await screen.findByRole("switch", { name: "Open ace at login" })).getAttribute("aria-checked"),
  ).toBe("true");
});

test("in the desktop app, turning off Thread done stops this computer's done notifications", async () => {
  const machine = desktop();
  const app = harness();
  await app.open("/settings/notifications");

  await userEvent.click(await screen.findByRole("switch", { name: "Thread done" }));

  await waitFor(() => expect(machine.stored().notifications.categories.finished).toBe(false));
  expect(machine.stored().notifications.categories.needsYou).toBeUndefined();
});

test("quiet hours set in the desktop app are the hours the desktop applies", async () => {
  const machine = desktop();
  await harness().open("/settings/notifications");

  await userEvent.click(await screen.findByRole("switch", { name: "Quiet hours" }));
  await waitFor(() =>
    expect(machine.stored().notifications.quietHours).toEqual({ start: 22 * 60, end: 8 * 60 }),
  );
  expect(await screen.findByText(/^22:00 to 08:00\./)).toBeTruthy();

  // 24-hour quarter hours: 22:00 reads as 22:00 in every locale.
  const start = screen.getByRole("combobox", { name: "Quiet hours start" });
  expect(start.textContent).toContain("22:00");
  await userEvent.click(start);
  await userEvent.click(await screen.findByRole("option", { name: "23:30" }));
  await waitFor(() =>
    expect(machine.stored().notifications.quietHours).toEqual({ start: 23 * 60 + 30, end: 480 }),
  );
  // A window that starts when it ends is not saved.
  await userEvent.click(screen.getByRole("combobox", { name: "Quiet hours start" }));
  await userEvent.click(await screen.findByRole("option", { name: "08:00" }));
  expect(machine.stored().notifications.quietHours).toEqual({ start: 23 * 60 + 30, end: 480 });

  await userEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));
  await waitFor(() => expect(machine.stored().notifications.quietHours).toBeNull());
  expect(screen.queryByLabelText("Quiet hours start")).toBeNull();
});

test("a browser offers no login item and says where notifications are set", async () => {
  const app = harness();
  await app.open("/settings/general");
  await screen.findByRole("switch", { name: "New threads use a worktree" });
  expect(screen.queryByRole("switch", { name: "Open ace at login" })).toBeNull();

  cleanup();
  await app.open("/settings/notifications");
  expect(await screen.findByText(/set in the ace desktop app/)).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Thread done" })).toBeNull();
});

test("desktop work preferences round-trip through the app bridge", async () => {
  const machine = desktop();
  const app = harness();
  await app.open("/settings/general");
  await userEvent.click(await screen.findByRole("switch", { name: "Keep running in background" }));
  await userEvent.click(screen.getByRole("switch", { name: "Prevent sleep while agents work" }));
  await userEvent.click(screen.getByRole("switch", { name: "Bounce dock icon for attention" }));
  await userEvent.click(screen.getByRole("button", { name: "Quick-thread global shortcut" }));
  await userEvent.keyboard("{Meta>}{Shift>}n{/Shift}{/Meta}");
  await waitFor(() =>
    expect(machine.stored()).toMatchObject({
      background: false,
      preventSleep: true,
      attention: false,
      globalShortcut: "CommandOrControl+Shift+N",
    }),
  );
  cleanup();
  await app.open("/settings/appearance");
  cleanup();
  await app.open("/settings/general");
  expect(
    (await screen.findByRole("switch", { name: "Prevent sleep while agents work" })).getAttribute(
      "aria-checked",
    ),
  ).toBe("true");
  expect(
    screen.getByRole("button", { name: "Quick-thread global shortcut" }).textContent,
  ).toContain("N");
  await userEvent.click(screen.getByRole("button", { name: "Turn off global shortcut" }));
  await waitFor(() => expect(machine.stored().globalShortcut).toBeNull());
  expect(screen.getByRole("button", { name: "Quick-thread global shortcut" }).textContent).toBe(
    "Off",
  );
});

test("tray pause is visible across pages and Resume reopens admission", async () => {
  let paused = true;
  const listeners = new Set<(value: { state: string; paused: boolean }) => void>();
  vi.stubGlobal("ace", {
    platform: "darwin",
    daemon: {
      connection: async () => ({ mode: "fake" }),
      status: async () => ({ state: "running", paused }),
      onStatus: (listener: (value: { state: string; paused: boolean }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      pause: async (next: boolean) => {
        paused = next;
        const status = { state: "running", paused };
        for (const listener of listeners) listener(status);
        return status;
      },
    },
  });
  const app = harness();
  app
    .play({
      thread: {
        id: "paused-example",
        workspaceId: "project",
        title: "Pause example",
        provider: "claude",
      },
      steps: [{ kind: "facts", facts: [facts.rootAgent("claude"), facts.turn("root")] }],
    })
    .runUntilBlocked();
  await app.open("/settings/general");
  expect(await screen.findByText("Paused", { exact: true })).toBeTruthy();
  cleanup();
  await app.open("/t/paused-example");
  await screen.findByRole("heading", { level: 1, name: "Pause example" });
  expect(await screen.findByText("Paused", { exact: true })).toBeTruthy();
  cleanup();
  await app.open("/settings/appearance");
  await userEvent.click(await screen.findByRole("button", { name: "Resume" }));
  await waitFor(() => expect(paused).toBe(false));
  expect(screen.queryByText("New work is on hold.")).toBeNull();
});
