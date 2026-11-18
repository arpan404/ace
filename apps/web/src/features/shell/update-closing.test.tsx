import { replayCursor } from "@ace/fake-daemon";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const closing = "ace is closing to update and will reopen in a few seconds";

/** The desktop preload's `window.ace.updates`, reporting what the test says. */
function desktopUpdates() {
  const listeners = new Set<(value: unknown) => void>();
  const status = (overrides: Record<string, unknown>) => ({
    state: "downloaded",
    currentVersion: "1.0.0",
    version: "1.1.0",
    releaseUrl: null,
    inPlace: true,
    percent: 100,
    waiting: 0,
    notes: [],
    olderReleases: 0,
    error: null,
    ...overrides,
  });
  Reflect.set(globalThis, "ace", {
    updates: {
      current: () => Promise.resolve(status({})),
      onStatus(listener: (value: unknown) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  return {
    restart: () =>
      act(() => {
        for (const listener of listeners)
          listener(status({ state: "installing", restarting: true }));
      }),
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => Reflect.deleteProperty(globalThis, "ace"));

test("an update restart keeps the closing notice instead of the reconnecting one", async () => {
  const updates = desktopUpdates();
  const app = harness();
  app.play(replayCursor()).runThrough("worked");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });

  // The person pressed Restart: the window says ace closes and reopens, before anything stops.
  updates.restart();
  expect(await screen.findAllByText(closing)).toHaveLength(1);

  // The daemon stops as part of the restart: still the same one sentence, never "Reconnecting".
  act(() => {
    app.daemon.refuseConnections(true);
    app.daemon.disconnectAll();
  });
  await waitFor(() => expect(app.client.state).not.toBe("ready"));
  expect(screen.getAllByText(closing)).toHaveLength(1);
  expect(screen.queryByText(/Reconnecting|Offline/)).toBeNull();
});
