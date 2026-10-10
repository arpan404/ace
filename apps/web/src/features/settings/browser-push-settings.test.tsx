import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("an unavailable push configuration stays visible with Retry and recovers without reconnecting", async () => {
  vi.stubGlobal("Notification", { permission: "granted" });
  vi.stubGlobal("PushManager", {});
  const before = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: async () => undefined },
  });
  const app = harness();
  app.daemon.seedServices({ notificationPublicKey: "A".repeat(87) });
  app.daemon.failRequests("notification.config");
  try {
    await app.open("/settings/notifications");
    const section = await screen.findByRole(
      "region",
      { name: "When ace is closed" },
      { timeout: 4000 },
    );
    const retry = await within(section).findByRole("button", { name: "Try again" });
    app.daemon.restoreRequests();
    await userEvent.click(retry);
    expect(
      await within(section).findByRole("button", { name: "Enable push on this browser" }),
    ).toBeTruthy();
  } finally {
    if (before) Object.defineProperty(navigator, "serviceWorker", before);
    else Reflect.deleteProperty(navigator, "serviceWorker");
  }
});
