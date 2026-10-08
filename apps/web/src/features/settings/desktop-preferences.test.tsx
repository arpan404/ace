import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

interface Stored {
  background: boolean;
  openAtLogin: boolean;
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
  const daemonValue = app.daemon.services.settings.get("app.openAtLogin");
  const toggle = await screen.findByRole("switch", { name: "Open ace at login" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  await userEvent.click(toggle);

  await waitFor(() => expect(machine.stored().openAtLogin).toBe(true));
  expect(
    (await screen.findByRole("switch", { name: "Open ace at login" })).getAttribute("aria-checked"),
  ).toBe("true");
  expect(app.daemon.services.settings.get("app.openAtLogin")).toBe(daemonValue);
});

test("in the desktop app, turning off Thread done stops this computer's done notifications", async () => {
  const machine = desktop();
  const app = harness();
  await app.open("/settings/notifications");
  const daemonValue = app.daemon.services.settings.get("notifications.onCompletion");

  await userEvent.click(await screen.findByRole("switch", { name: "Thread done" }));

  await waitFor(() => expect(machine.stored().notifications.categories.finished).toBe(false));
  expect(machine.stored().notifications.categories.needsYou).toBeUndefined();
  expect(app.daemon.services.settings.get("notifications.onCompletion")).toBe(daemonValue);
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

test("a browser offers notification categories in Settings", async () => {
  const app = harness();
  await app.open("/settings/general");
  await screen.findByRole("switch", { name: "New threads use a worktree" });
  expect(screen.queryByRole("switch", { name: "Open ace at login" })).toBeNull();

  await app.open("/settings/notifications");
  expect(await screen.findByRole("switch", { name: "Agent says" })).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Thread done" })).toBeNull();
});

test("a configured browser can enable and disable push from Notifications settings", async () => {
  let subscription: { toJSON(): PushSubscriptionJSON; unsubscribe(): Promise<boolean> } | null =
    null;
  const registration = {
    pushManager: {
      getSubscription: async () => subscription,
      subscribe: async () => {
        subscription = {
          toJSON: () => ({
            endpoint: "https://push.example.test/browser",
            keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
          }),
          unsubscribe: async () => {
            subscription = null;
            return true;
          },
        };
        return subscription;
      },
    },
  };
  vi.stubGlobal("Notification", {
    permission: "default",
    requestPermission: async () => "granted",
  });
  vi.stubGlobal("PushManager", function PushManager() {});
  const original = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: async () => registration,
      register: async () => registration,
      ready: Promise.resolve(registration),
    },
  });
  try {
    const app = harness();
    app.daemon.seedServices({ notificationPublicKey: "a".repeat(87) });
    await app.open("/settings/notifications");
    await userEvent.click(
      await screen.findByRole("button", { name: "Enable push on this browser" }),
    );
    await screen.findByRole("button", { name: "Disable push on this browser" });
    expect(subscription).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Disable push on this browser" }));
    await screen.findByRole("button", { name: "Enable push on this browser" });
    expect(subscription).toBeNull();
  } finally {
    if (original) Object.defineProperty(navigator, "serviceWorker", original);
    else Reflect.deleteProperty(navigator, "serviceWorker");
  }
});
