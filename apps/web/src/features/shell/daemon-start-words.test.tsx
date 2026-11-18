import { replayCursor } from "@ace/fake-daemon";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/** The desktop preload's daemon bridge, reporting the daemon state the test says. */
function desktopDaemon(initial: Record<string, unknown>) {
  const listeners = new Set<(value: unknown) => void>();
  Reflect.set(globalThis, "ace", {
    platform: "darwin",
    daemon: {
      connection: () => new Promise(() => {}),
      status: () => Promise.resolve(initial),
      onStatus(listener: (value: unknown) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  return {
    report: (status: Record<string, unknown>) =>
      act(() => {
        for (const listener of listeners) listener(status);
      }),
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => Reflect.deleteProperty(globalThis, "ace"));

test("while the desktop starts its daemon, the window says its step, never Reconnecting", async () => {
  const desktop = desktopDaemon({ state: "running", restarts: 0, paused: false });
  const app = harness();
  app.play(replayCursor()).runThrough("worked");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });

  // Quit completely and opened again: the window shows what it kept while the daemon starts.
  desktop.report({ state: "starting", stage: "launching", restarts: 0, paused: false });
  act(() => {
    app.daemon.refuseConnections(true);
    app.daemon.disconnectAll();
  });
  await waitFor(() => expect(app.client.state).toBe("reconnecting"));
  expect(await screen.findByText("Starting ace's background service…")).toBeTruthy();
  expect(screen.queryByText(/Reconnecting/)).toBeNull();

  // A crash restart says so, in the startup screen's words.
  desktop.report({
    state: "restarting",
    message: "The daemon exited",
    restarts: 1,
    paused: false,
  });
  expect(
    await screen.findByText("ace's background service stopped, so ace is starting it again…"),
  ).toBeTruthy();

  // Running again but out of reach: that is reconnecting, and is said so.
  desktop.report({ state: "running", restarts: 1, paused: false });
  expect(await screen.findByText("Reconnecting…")).toBeTruthy();
});
