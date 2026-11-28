import { host } from "./test-host.ts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { closeBrowserFixtures, liveBrowser as live, viewport } from "./browser-fixture.ts";
import { type RecordingSink, until } from "./sheet-fixture.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(host, "video");
  await closeBrowserFixtures();
});

const state = (sink: RecordingSink) =>
  sink.read("browser:view")?.state as
    | { url: string; activeTabId: string | null; tabs: { id: string; title: string }[] }
    | null
    | undefined;

/** The view's pane reports, in order: its subscribes and its capture updates. */
const paneReports = (requested: unknown[]) =>
  requested.filter(
    (request): request is { type: string } =>
      typeof request === "object" &&
      request !== null &&
      "type" in request &&
      (request.type === "browser.subscribe" || request.type === "browser.capture"),
  );

describe("Live browser view", () => {
  test("hardware HEVC is named first in the view's subscribe", async () => {
    Object.assign(host, { video: { decoders: () => ["hvc1.1.6.L153.B0", "avc1.42E033"] } });
    const { sink, view, requested } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => state(sink) != null, "browser state");
    expect(requested).toContainEqual(
      expect.objectContaining({
        type: "browser.subscribe",
        video: { codecs: ["hvc1.1.6.L153.B0", "avc1.42E033"] },
      }),
    );
  });
  test("a thread with an open tab offers its browser; one without doesn't", async () => {
    const withBrowser = await live();
    withBrowser.view.probe("web", 3);
    await until(() => withBrowser.sink.read("browser:available") !== undefined, "probe");
    expect(withBrowser.sink.read("browser:available")).toMatchObject({ live: true, epoch: 3 });

    const without = await live({ browser: false });
    without.view.probe("web", 1);
    await until(() => without.sink.read("browser:available") !== undefined, "probe");
    expect(without.sink.read("browser:available")).toMatchObject({ live: false });
  });

  test("opening shows the browser's address and tabs", async () => {
    const { sink, view } = await live();
    expect(view.action({ kind: "open", threadId: "web", viewport })).toBe(true);
    await until(() => state(sink)?.url === "https://shop.test/cart", "browser state");
    expect(state(sink)?.tabs).toHaveLength(1);
  });

  test("the person's touches reach the shown tab", async () => {
    const { daemon, sink, view } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => state(sink)?.activeTabId != null, "browser state");
    const touch = {
      kind: "touch",
      event: "touchStart",
      points: [{ x: 120, y: 300, id: 0 }],
    };
    expect(view.action({ kind: "input", input: touch })).toBe(true);
    await until(() => daemon.browser.wireInputs.length > 0, "input");
    expect(daemon.browser.wireInputs[0]).toEqual({
      threadId: "web",
      tabId: state(sink)?.activeTabId,
      input: touch,
    });
    // Input the protocol doesn't take is refused before it is sent.
    expect(view.action({ kind: "input", input: { kind: "touch", event: "wave" } })).toBe(false);
  });

  test("a host without HEVC subscribes for H.264 video", async () => {
    const { sink, view, requested } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => state(sink) != null, "browser state");
    expect(requested).toContainEqual(
      expect.objectContaining({
        type: "browser.subscribe",
        threadId: "web",
        binaryFrames: true,
        video: { codecs: ["avc1.42E033"] },
      }),
    );
  });

  test("switching tabs starts the pictures again and shows the new tab's page state", async () => {
    const { daemon, sink, view, push } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => state(sink)?.activeTabId != null, "browser state");
    const first = state(sink)?.activeTabId ?? "";
    const generation = sink.read("browser:view")?.generation as number;
    const opened = daemon.browser.personOpen("web", "https://shop.test/pay");
    push({
      type: "browser.page",
      threadId: "web",
      tabId: opened,
      page: { focus: { type: "email", rect: { x: 10, y: 20, width: 200, height: 30 } } },
    });
    push({
      type: "browser.page",
      threadId: "web",
      tabId: first,
      page: { cursor: "pointer" },
    });
    view.action({ kind: "tab", tabId: opened });
    await until(() => state(sink)?.activeTabId === opened, "tab switch");
    expect(sink.read("browser:view")?.generation).toBeGreaterThan(generation);
    // The new tab's earlier report was cleared with the restart; its next one shows.
    push({
      type: "browser.page",
      threadId: "web",
      tabId: opened,
      page: {
        picker: {
          pickerId: "p1",
          kind: "select",
          rect: { x: 0, y: 0, width: 100, height: 20 },
          value: "b",
          options: [
            { value: "a", label: "Air" },
            { value: "b", label: "Boat" },
          ],
        },
      },
    });
    expect(sink.read("browser:page")).toMatchObject({
      tabId: opened,
      page: { picker: { pickerId: "p1", value: "b" } },
    });
    push({ type: "browser.page", threadId: "web", tabId: first, page: { cursor: "text" } });
    expect(sink.read("browser:page")).toMatchObject({ tabId: opened });
  });

  test("the person's input round trip is measured, and kept when the browser opens again", async () => {
    const { sink, view } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => state(sink)?.activeTabId != null, "browser state");
    expect(sink.read("browser:latency")).toBeUndefined();
    const touch = { kind: "touch", event: "touchStart", points: [{ x: 1, y: 1, id: 0 }] };
    view.action({ kind: "input", input: touch });
    await until(() => sink.read("browser:latency") !== undefined, "latency");
    // The fixture's clock moves one millisecond for each reading.
    expect(sink.read("browser:latency")).toEqual({
      type: "browser.latency",
      threadId: "web",
      ms: 1,
    });
    view.close();
    expect(sink.read("browser:latency")).toBeUndefined();
    view.action({ kind: "open", threadId: "web", viewport });
    expect(sink.read("browser:latency")).toMatchObject({ threadId: "web", ms: 1 });
  });

  test("the page's sound reaches this phone only once the person turns it on, and every view starts muted", async () => {
    const { sink, view, requested } = await live();
    const reports = () => paneReports(requested);
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => state(sink) != null, "browser state");
    expect(reports().at(-1)).not.toHaveProperty("viewport.audio");

    expect(view.action({ kind: "audio", on: true })).toBe(true);
    expect(reports().at(-1)).toMatchObject({ type: "browser.capture", viewport: { audio: true } });
    // A resize keeps the sound on.
    view.action({ kind: "viewport", viewport: { ...viewport, width: 400 } });
    expect(reports().at(-1)).toMatchObject({
      type: "browser.capture",
      viewport: { width: 400, audio: true },
    });
    view.action({ kind: "audio", on: false });
    expect(reports().at(-1)).toMatchObject({ type: "browser.capture" });
    expect(reports().at(-1)).not.toHaveProperty("viewport.audio");

    view.action({ kind: "audio", on: true });
    view.action({ kind: "close" });
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => reports().at(-1)?.type === "browser.subscribe", "subscribed again");
    expect(reports().at(-1)).not.toHaveProperty("viewport.audio");
  });

  test("turning the sound on or off while the subscribe is on its way reaches the daemon once it lands", async () => {
    // On: the subscribe went out muted.
    const on = await live({ holdSubscribes: true });
    on.view.action({ kind: "open", threadId: "web", viewport });
    await until(() => paneReports(on.requested).length === 1, "the subscribe");
    on.view.action({ kind: "audio", on: true });
    expect(paneReports(on.requested)).toHaveLength(1);
    on.releaseSubscribes();
    await until(() => paneReports(on.requested).length === 2, "sound reported");
    expect(paneReports(on.requested).at(-1)).toMatchObject({
      type: "browser.capture",
      viewport: { audio: true },
    });

    // Off: a resubscribe (the session came back) went out with sound on, and the person muted
    // it before its reply.
    const off = await live({ holdSubscribes: true });
    off.view.action({ kind: "open", threadId: "web", viewport });
    await until(() => paneReports(off.requested).length === 1, "the subscribe");
    off.releaseSubscribes();
    await until(() => state(off.sink) != null, "browser state");
    off.view.action({ kind: "audio", on: true });
    const before = paneReports(off.requested).length;
    off.daemon.disconnectAll();
    await until(
      () =>
        paneReports(off.requested)
          .slice(before)
          .some((r) => r.type === "browser.subscribe"),
      "the resubscribe",
    );
    expect(paneReports(off.requested).at(-1)).toMatchObject({ viewport: { audio: true } });
    const sent = paneReports(off.requested).length;
    off.view.action({ kind: "audio", on: false });
    expect(paneReports(off.requested)).toHaveLength(sent);
    off.releaseSubscribes();
    await until(() => paneReports(off.requested).length > sent, "mute reported");
    expect(paneReports(off.requested).at(-1)).toMatchObject({ type: "browser.capture" });
    expect(paneReports(off.requested).at(-1)).not.toHaveProperty("viewport.audio");
  });

  test("a daemon that comes back without the thread's browser shows no page, not the tab it had", async () => {
    const { daemon, sink, view, requested } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => state(sink)?.activeTabId != null, "browser state");
    const before = paneReports(requested).length;
    // The daemon restarts and its browser doesn't come back with it.
    daemon.disconnectAll();
    daemon.browser.close("web");
    await until(
      () =>
        paneReports(requested)
          .slice(before)
          .some((r) => r.type === "browser.subscribe"),
      "the resubscribe",
    );
    await until(() => state(sink) === null, "no page");
    expect(sink.read("browser:view")).toMatchObject({ error: null, state: null });
    // Nothing points at the tab the daemon no longer has.
    expect(sink.read("browser:page")).toMatchObject({ tabId: null, page: null });
  });

  test("a thread whose browser isn't open shows no page, not a failure, and is asked again", async () => {
    const { daemon, sink, view, scheduled, requested, releaseSubscribes } = await live({
      browser: false,
      holdSubscribes: true,
    });
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => paneReports(requested).length === 1, "subscribe sent");
    const before = sink.putsOf.get("browser:view") ?? 0;
    releaseSubscribes();
    await until(() => (sink.putsOf.get("browser:view") ?? 0) > before, "refused subscribe");
    // The phone offers "Open a page" here; an error would say the machine can't be reached.
    expect(sink.read("browser:view")).toMatchObject({ error: null, state: null });
    expect(scheduled.length).toBe(1);
    daemon.browser.drive("web", { url: "https://shop.test/" });
    scheduled.shift()?.();
    await until(() => {
      releaseSubscribes();
      return state(sink)?.url === "https://shop.test/";
    }, "subscribed later");
    expect(sink.read("browser:view")?.error).toBeNull();
    view.close();
    expect(sink.read("browser:view")).toBeUndefined();
    expect(view.action({ kind: "ack", sequence: 1 })).toBe(false);
  });
});
