import { FakeDaemon, ScenarioPlayer, failingSubagent } from "@ace/fake-daemon";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { fakeClient } from "@/test/harness.tsx";
import type { Schedule } from "../schedule.ts";
import type { PageVisibility } from "@/lib/page-visibility.ts";
import { daemonPreview } from "./daemon-preview.ts";

/** Timers the test fires by hand. */
function manualTimers() {
  const due = new Set<() => void>();
  const schedule: Schedule = (callback) => {
    due.add(callback);
    return () => due.delete(callback);
  };
  return {
    schedule,
    fire() {
      const now = [...due];
      due.clear();
      for (const callback of now) callback();
    },
  };
}

/** A page the test hides and shows. */
function page(): PageVisibility & { set(visible: boolean): void } {
  let shown = true;
  const listeners = new Set<() => void>();
  return {
    visible: () => shown,
    watch(changed) {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
    set(visible) {
      shown = visible;
      for (const listener of listeners) listener();
    },
  };
}

test("a hidden window stops polling for dev servers and reads them again once shown", async () => {
  let now = 1_000;
  const daemon = new FakeDaemon({ clock: () => (now += 1) });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const timers = manualTimers();
  const window = page();
  const preview = daemonPreview(client, { schedule: timers.schedule, visibility: window });
  const before = preview.version;
  const stop = preview.watch("thread-settings");
  // The first read has answered before the window hides.
  await waitFor(() => expect(preview.version).toBeGreaterThan(before));

  window.set(false);
  daemon.browser.serve("thread-settings", {
    port: 3000,
    origin: "http://localhost:3000",
    name: "api",
    source: "listener",
  });
  // The retry comes due while hidden: nothing is asked.
  timers.fire();
  await client.request({ type: "browser.origins.list", threadId: "thread-settings" });
  expect(preview.servers("thread-settings")).toEqual([]);

  window.set(true);
  await waitFor(() =>
    expect(preview.servers("thread-settings").map((server) => server.port)).toEqual([3000]),
  );
  stop();
});

test("native visibility holds the fallback frame until screencast viewing resumes", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  daemon.browser.drive("thread-settings", { url: "http://localhost:5173", backend: "embedded" });
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const timers = manualTimers();
  const preview = daemonPreview(client, { schedule: timers.schedule, visibility: page() });
  const stop = preview.watch("thread-settings");
  await preview.open("thread-settings", failingSubagent().thread.workspaceId);
  await waitFor(() => expect(preview.frame("thread-settings")).toBeDefined());
  const before = preview.frame("thread-settings")?.src;
  preview.nativeShown?.("thread-settings", true);
  daemon.browser.type("thread-settings", "native-only-edit");
  await client.request({ type: "browser.origins.list", threadId: "thread-settings" });
  expect(preview.frame("thread-settings")?.src).toBe(before);
  preview.nativeShown?.("thread-settings", false);
  daemon.browser.type("thread-settings", "remote-edit");
  await waitFor(() => expect(preview.frame("thread-settings")?.src).not.toBe(before));
  stop();
});
