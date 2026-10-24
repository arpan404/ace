import { afterEach, describe, expect, test } from "vitest";
import { closeBrowserFixtures, liveBrowser as live, viewport } from "./browser-fixture.ts";
import { type RecordingSink, until } from "./sheet-fixture.ts";

afterEach(closeBrowserFixtures);

const state = (sink: RecordingSink) =>
  sink.read("browser:view")?.state as
    | { url: string; activeTabId: string | null; tabs: { id: string; title: string }[] }
    | null
    | undefined;

describe("Live browser view", () => {
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

  test("opening sizes the page to the phone and shows the browser's address", async () => {
    const { daemon, sink, view } = await live();
    expect(view.action({ kind: "open", threadId: "web", viewport })).toBe(true);
    await until(() => state(sink)?.url === "https://shop.test/cart", "browser state");
    await until(() => daemon.browser.frame("web")?.width === 390, "resized page");
    expect(daemon.browser.frame("web")?.height).toBe(700);
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

  test("the view always subscribes for H.264 video", async () => {
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

  test("decoded chunks are acknowledged as video, a decode error asks for a keyframe", async () => {
    const { sink, view, sent } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => state(sink) != null, "browser state");
    view.action({ kind: "ack", sequence: 4 });
    view.action({ kind: "ack", sequence: 9, keyframe: true });
    expect(sent).toEqual([
      expect.objectContaining({ type: "browser.ack", threadId: "web", sequence: 4, video: true }),
      expect.objectContaining({
        type: "browser.ack",
        threadId: "web",
        sequence: 9,
        video: true,
        keyframe: true,
      }),
    ]);
    expect(sent[0]).not.toHaveProperty("keyframe");
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

  test("a tab the phone switches to is laid out at the phone's size, as a touch screen", async () => {
    const { daemon, sink, view, requested } = await live();
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => state(sink)?.activeTabId != null, "browser state");
    const opened = daemon.browser.personOpen("web", "https://shop.test/pay");
    const resizes = () =>
      requested.filter(
        (message) =>
          (message as { type: string }).type === "browser.execute" &&
          (message as { command: { action: string } }).command.action === "resize",
      );
    const before = resizes().length;
    view.action({ kind: "tab", tabId: opened });
    await until(() => state(sink)?.activeTabId === opened, "tab switch");
    await until(() => resizes().length > before, "new tab sized");
    expect(resizes().at(-1)).toMatchObject({
      threadId: "web",
      command: { action: "resize", width: 390, height: 700, touch: true, devicePixelRatio: 3 },
    });
  });

  test("closing the view stops its patches; a browser that isn't open yet is asked again", async () => {
    const { daemon, sink, view, scheduled } = await live({ browser: false });
    view.action({ kind: "open", threadId: "web", viewport });
    await until(() => sink.read("browser:view")?.error != null, "refused subscribe");
    expect(scheduled.length).toBe(1);
    daemon.browser.drive("web", { url: "https://shop.test/" });
    scheduled.shift()?.();
    await until(() => state(sink)?.url === "https://shop.test/", "subscribed later");
    expect(sink.read("browser:view")?.error).toBeNull();
    view.close();
    expect(sink.read("browser:view")).toBeUndefined();
    expect(view.action({ kind: "ack", sequence: 1 })).toBe(false);
  });
});
