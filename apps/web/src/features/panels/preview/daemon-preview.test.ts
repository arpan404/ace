import { fakePreviewMedia } from "./stream-test-support.ts";
import { FakeDaemon, ScenarioPlayer, failingSubagent } from "@ace/fake-daemon";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { fakeClient } from "@/test/fake-client.ts";
import type { Schedule } from "../schedule.ts";
import type { PageVisibility } from "@/lib/page-visibility.ts";
import { daemonPreview } from "./daemon-preview.ts";
import { heldDecoder, instantDecoder, playsH264 } from "./video-test-support.ts";

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
  const preview = daemonPreview(client, {
    media: (await fakePreviewMedia(daemon)).media,
    schedule: timers.schedule,
    visibility: window,
  });
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
  await client.request({ type: "browser.tabs.list", threadId: "thread-settings" });
  expect(preview.servers("thread-settings")).toEqual([]);

  window.set(true);
  await waitFor(() =>
    expect(preview.servers("thread-settings").map((server) => server.port)).toEqual([3000]),
  );
  stop();
});

test("while a native view shows the page, video isn't decoded; once it steps away, pictures resume", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  daemon.browser.drive("thread-settings", { url: "http://localhost:5173", backend: "embedded" });
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const decoder = instantDecoder();
  const preview = daemonPreview(client, {
    media: (await fakePreviewMedia(daemon)).media,
    schedule: manualTimers().schedule,
    visibility: page(),
    videoDecoder: decoder.factory,
    videoSupport: playsH264,
  });
  const stop = preview.watch("thread-settings");
  await preview.open("thread-settings", failingSubagent().thread.workspaceId);
  await waitFor(() => expect(preview.frame("thread-settings")).toBeDefined());
  const before = preview.frame("thread-settings")?.sequence;
  preview.nativeShown?.("thread-settings", true);
  daemon.browser.type("thread-settings", "native-only-edit");
  await client.request({ type: "browser.tabs.list", threadId: "thread-settings" });
  expect(preview.frame("thread-settings")?.sequence).toBe(before);
  expect(decoder.pictures.map((picture) => picture.sequence)).toEqual([before]);
  preview.nativeShown?.("thread-settings", false);
  daemon.browser.type("thread-settings", "remote-edit");
  await waitFor(() =>
    expect(preview.frame("thread-settings")?.sequence).toBe(
      daemon.browser.frame("thread-settings")?.sequence,
    ),
  );
  stop();
});

test("retired preview sources free their kept pictures and document listeners", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  daemon.browser.drive("thread-settings", { url: "http://localhost:5173" });
  const listeners = new Set<() => void>();
  const visibility: PageVisibility = {
    visible: () => true,
    watch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const decoder = instantDecoder();
  for (let n = 0; n < 8; n++) {
    const client = fakeClient(daemon);
    await client.start();
    await waitFor(() => expect(client.state).toBe("ready"));
    const timers = manualTimers();
    const preview = daemonPreview(client, {
      media: (await fakePreviewMedia(daemon)).media,
      visibility,
      schedule: timers.schedule,
      videoDecoder: decoder.factory,
      videoSupport: playsH264,
    });
    const unwatch = preview.watch("thread-settings");
    await preview.open("thread-settings", failingSubagent().thread.workspaceId);
    await waitFor(() => expect(preview.frame("thread-settings")).toBeDefined());
    unwatch();
    await Promise.resolve();
    // Unwatch keeps this picture for a quick return while the client lives.
    expect(preview.frame("thread-settings")).toBeDefined();
    preview.dispose();
    preview.dispose();
    await client.close();
    expect(preview.frame("thread-settings")).toBeUndefined();
    const version = preview.version;
    for (const listener of listeners) listener();
    timers.fire();
    expect(preview.version).toBe(version);
  }
  expect(listeners.size).toBe(0);
  expect(decoder.pictures.length).toBeGreaterThanOrEqual(8);
  expect(decoder.pictures.every((picture) => picture.closed)).toBe(true);
});

test("a picture decoded after its preview owner retires is freed without being shown", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const decoder = heldDecoder();
  const preview = daemonPreview(client, {
    media: (await fakePreviewMedia(daemon)).media,
    schedule: manualTimers().schedule,
    visibility: page(),
    videoDecoder: decoder.factory,
    videoSupport: playsH264,
  });
  preview.watch("thread-settings");
  await preview.open("thread-settings", failingSubagent().thread.workspaceId);
  await waitFor(() => expect(decoder.decoders[0]?.pending.length).toBe(1));
  preview.dispose();
  decoder.decoders[0]?.flush();
  expect(decoder.pictures.map((picture) => picture.closed)).toEqual([true]);
  expect(preview.frame("thread-settings")).toBeUndefined();
});

test("a watched thread lists its detected dev servers and follows the daemon's pushed changes", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const preview = daemonPreview(client, {
    media: (await fakePreviewMedia(daemon)).media,
    schedule: manualTimers().schedule,
    visibility: page(),
  });
  let changes = 0;
  preview.subscribe(() => changes++, "thread-settings");
  const stop = preview.watch("thread-settings");
  await waitFor(() =>
    expect(preview.suggestions("thread-settings").map((server) => server.title)).toEqual([
      "Vite + React + TS",
      "Next.js",
    ]),
  );
  expect(preview.suggestions("thread-settings")[0]).toMatchObject({
    url: "http://localhost:5173/",
    source: "terminal",
  });

  const before = changes;
  // A source this client doesn't know still decodes, as a found listener.
  daemon.services.pushPreviewSuggestions("thread-settings", [
    { port: 4321, url: "http://localhost:4321/", title: "Astro", source: "a-newer-source" },
  ]);
  await waitFor(() =>
    expect(preview.suggestions("thread-settings")).toEqual([
      {
        port: 4321,
        url: "http://localhost:4321/",
        title: "Astro",
        iconUrl: undefined,
        source: "listener",
      },
    ]),
  );
  expect(changes).toBeGreaterThan(before);
  // Another thread's push changes nothing here.
  daemon.services.pushPreviewSuggestions("thread-other", []);
  await client.request({ type: "browser.tabs.list", threadId: "thread-settings" });
  expect(preview.suggestions("thread-settings").map((server) => server.port)).toEqual([4321]);
  stop();
  preview.dispose();
});

test("a browser an agent opens in a watched thread shows without waiting for the next retry", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  // The retry timer never fires in this test.
  const preview = daemonPreview(client, {
    media: (await fakePreviewMedia(daemon)).media,
    schedule: manualTimers().schedule,
    visibility: page(),
  });
  const before = preview.version;
  const stop = preview.watch("thread-settings");
  // The first look found no browser.
  await waitFor(() => expect(preview.version).toBeGreaterThan(before));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(preview.view("thread-settings")).toBeUndefined();

  daemon.browser.drive("thread-settings", { url: "http://localhost:5173", backend: "embedded" });
  await waitFor(() => expect(preview.view("thread-settings")?.url).toBe("http://localhost:5173"));
  stop();
});

test("ace-media killed: the view reconnects its media connection, subscribes on the new one and resumes at a keyframe", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  daemon.browser.drive("thread-settings", { url: "http://localhost:5173" });
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const decoder = instantDecoder();
  const link = await fakePreviewMedia(daemon);
  const preview = daemonPreview(client, {
    media: link.media,
    schedule: manualTimers().schedule,
    visibility: page(),
    videoDecoder: decoder.factory,
    videoSupport: playsH264,
  });
  const stop = preview.watch("thread-settings");
  await preview.open("thread-settings", failingSubagent().thread.workspaceId);
  await waitFor(() => expect(preview.frame("thread-settings")).toBeDefined());
  const first = link.media.binding()?.connection;
  const decodersBefore = decoder.decoders.length;
  // ace-media dies: every media connection closes under the client.
  daemon.media.dropAll();
  // It asks for a new one, opens it, and the view subscribes again naming it.
  await waitFor(() => {
    const now = link.media.binding()?.connection;
    expect(now).toBeDefined();
    expect(now).not.toBe(first);
  });
  daemon.browser.type("thread-settings", "after-restart");
  // Pictures resume in a fresh decoder, which only starts from a keyframe.
  await waitFor(() => expect(decoder.decoders.length).toBeGreaterThan(decodersBefore));
  await waitFor(() =>
    expect(decoder.pictures.findLast((picture) => !picture.closed)?.sequence).toBe(
      preview.frame("thread-settings")?.sequence,
    ),
  );
  expect(preview.undelivered?.("thread-settings")).toBeUndefined();
  stop();
  preview.dispose();
  link.connection.stop();
});

test("a view whose subscribe ace-media can't serve says why instead of staying blank", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, failingSubagent()).step();
  daemon.browser.drive("thread-settings", { url: "http://localhost:5173" });
  const client = fakeClient(daemon);
  await client.start();
  await waitFor(() => expect(client.state).toBe("ready"));
  const link = await fakePreviewMedia(daemon);
  // ace-media is gone before the view subscribes: its connection is no longer live.
  daemon.media.dropAll();
  const preview = daemonPreview(client, {
    media: { ...link.media, binding: () => ({ connection: "mc_fake00000001" }) },
    schedule: manualTimers().schedule,
    visibility: page(),
    videoDecoder: instantDecoder().factory,
    videoSupport: playsH264,
  });
  const stop = preview.watch("thread-settings");
  await preview.open("thread-settings", failingSubagent().thread.workspaceId);
  await waitFor(() =>
    expect(preview.undelivered?.("thread-settings")).toBe("Live video isn't available now."),
  );
  expect(preview.frame("thread-settings")).toBeUndefined();
  stop();
  preview.dispose();
  link.connection.stop();
});
