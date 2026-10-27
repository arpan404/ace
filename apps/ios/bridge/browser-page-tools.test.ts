import { afterEach, describe, expect, test } from "vitest";
import { closeBrowserFixtures, liveBrowser, viewport } from "./browser-fixture.ts";
import type { PhoneFiles } from "./browser-page-tools.ts";
import { type RecordingSink, until } from "./sheet-fixture.ts";

/*
 * The page's own commands from the phone's browser menu, over a real client and the fake
 * daemon: mute, record, clear data, page source, print, screenshots at several sizes, the
 * engine's extensions, and a download copied onto the phone.
 */

afterEach(closeBrowserFixtures);

interface Shown {
  activeTabId: string | null;
  shown: { muted: boolean; mention: { label: string; tabId: string; url: string } | null } | null;
  recording: { byPerson: boolean; here: boolean } | null;
  ownChrome: boolean;
}
const state = (sink: RecordingSink) => sink.read("browser:view")?.state as Shown | null | undefined;
const done = (sink: RecordingSink) =>
  sink.read("browser:done") as { message: string; detail: string | null } | undefined;

/** A finished download of the shown tab, with its bytes on the fake machine. */
async function offerDownload(
  daemon: Awaited<ReturnType<typeof liveBrowser>>["daemon"],
  sink: RecordingSink,
  tabId: string,
  downloadId: string,
  bytes: Uint8Array,
) {
  daemon.browser.downloadBytes.set(`web\u0000${downloadId}`, bytes);
  daemon.browser.downloadAdd("web", {
    downloadId,
    tabId,
    filename: `${downloadId}.csv`,
    bytes: bytes.length,
    mimeType: "text/csv",
    flags: [],
    state: "complete",
    path: `/fixture/${downloadId}.csv`,
  });
  await until(
    () => (state(sink) as { downloads?: unknown[] } | null)?.downloads?.length === 1,
    "listed",
  );
}

async function opened(files?: PhoneFiles) {
  const fixture = await liveBrowser(files ? { context: { files } } : {});
  fixture.view.action({ kind: "open", threadId: "web", viewport });
  await until(() => state(fixture.sink)?.activeTabId != null, "browser state");
  const tabId = () => state(fixture.sink)?.activeTabId ?? "";
  return { ...fixture, tabId };
}

describe("The phone's page commands", () => {
  test("muting the shown tab silences it until the person unmutes it", async () => {
    const { daemon, sink, view, tabId } = await opened();
    daemon.browser.sound("web", tabId(), true, false);
    await until(() => state(sink)?.shown?.muted === false, "audible");
    view.action({ kind: "mute", tabId: tabId(), muted: true });
    await until(() => state(sink)?.shown?.muted === true, "muted");
    expect(daemon.browser.tab("web")?.muted).toBe(true);
    view.action({ kind: "mute", tabId: tabId(), muted: false });
    await until(() => state(sink)?.shown?.muted === false, "unmuted");
  });

  test("a recording started here shows as this phone's, and stopping it says where it went", async () => {
    const { sink, view } = await opened();
    view.action({ kind: "record", on: true });
    await until(() => state(sink)?.recording?.here === true, "recording here");
    expect(state(sink)?.recording).toEqual({ byPerson: true, here: true });
    view.action({ kind: "record", on: false });
    await until(() => state(sink)?.recording === null, "stopped");
    await until(() => done(sink)?.message === "Recording saved to this thread", "saved");
    expect(done(sink)?.detail).toBe("player.html");
  });

  test("clearing browsing data, printing and the page source each answer in one place", async () => {
    const { sink, view } = await opened();
    view.action({ kind: "clearData" });
    await until(() => done(sink)?.message === "Browsing data cleared", "cleared");
    view.action({ kind: "print" });
    await until(() => done(sink)?.message === "PDF saved to this thread", "printed");
    expect(done(sink)?.detail).toBe("page.pdf");
    view.action({ kind: "source", open: true });
    await until(() => sink.read("browser:source") !== undefined, "source");
    expect(sink.read("browser:source")).toMatchObject({
      source: expect.stringContaining("<title>Synthetic fixture page</title>"),
      truncated: false,
    });
    view.action({ kind: "source", open: false });
    expect(sink.read("browser:source")).toBeUndefined();
  });

  test("screenshots at several sizes come back one per size, in the order asked", async () => {
    const { daemon, sink, view, tabId } = await opened();
    view.action({ kind: "sizes", sizes: ["phone", "desktop"] });
    await until(() => Array.isArray(sink.read("browser:sizes")?.images), "captured");
    const images = sink.read("browser:sizes")?.images as { size: string; width: number }[];
    expect(images.map((image) => [image.size, image.width])).toEqual([
      ["phone", 390],
      ["desktop", 1440],
    ]);
    expect(daemon.browser.sizedCaptures.at(-1)).toMatchObject({
      tabId: tabId(),
      sizes: ["phone", "desktop"],
    });
  });

  test("the engine's extensions are listed as it reports them, an empty engine as none", async () => {
    const { daemon, sink, view } = await opened();
    view.action({ kind: "extensions" });
    await until(() => Array.isArray(sink.read("browser:extensions")?.items), "listed");
    expect(sink.read("browser:extensions")?.items).toEqual([]);
    daemon.browser.extensions = [
      { id: "ublock", name: "uBlock Origin", version: "1.60", enabled: false },
    ];
    view.action({ kind: "extensions" });
    await until(
      () => (sink.read("browser:extensions")?.items as unknown[] | null)?.length === 1,
      "one",
    );
    expect(sink.read("browser:extensions")?.items).toEqual([
      { id: "ublock", name: "uBlock Origin", version: "1.60", enabled: false },
    ]);
  });

  test("a finished download is written to the phone a chunk at a time, then offered", async () => {
    const written: { offset: number; done: boolean; bytes: Buffer }[] = [];
    const files: PhoneFiles = {
      write: async (input, body) => {
        written.push({
          offset: input.offset,
          done: input.done,
          bytes: Buffer.from(body, "base64"),
        });
        return "";
      },
      discard: async () => "",
    };
    const { daemon, sink, view, tabId } = await opened(files);
    const bytes = new Uint8Array(1_300_000).map((_, index) => index % 251);
    await offerDownload(daemon, sink, tabId(), "report", bytes);
    view.action({ kind: "save", downloadId: "report" });
    await until(() => sink.read("browser:saving:web:report")?.phase === "ready", "saved");
    expect(Buffer.concat(written.map((write) => write.bytes))).toEqual(Buffer.from(bytes));
    // Each write is one chunk as it arrived, in order: the file is never held whole.
    expect(Math.max(...written.map((write) => write.bytes.length))).toBeLessThanOrEqual(256 * 1024);
    expect(written.map((write) => write.offset)).toEqual(
      written.map((_, index) => index * 256 * 1024),
    );
    expect(written.filter((write) => write.done)).toHaveLength(1);
    expect(written.at(-1)?.done).toBe(true);
  });

  test("a save that fails part way leaves nothing on the phone and says so", async () => {
    const discarded: string[] = [];
    let writes = 0;
    const files: PhoneFiles = {
      write: async () => {
        if (++writes === 2) throw new Error("The phone is full.");
        return "";
      },
      discard: async (input) => {
        discarded.push(input.id);
        return "";
      },
    };
    const { daemon, sink, view, tabId } = await opened(files);
    await offerDownload(daemon, sink, tabId(), "report", new Uint8Array(700_000));
    view.action({ kind: "save", downloadId: "report" });
    await until(() => sink.read("browser:saving:web:report")?.phase === "failed", "failed");
    expect(sink.read("browser:saving:web:report")?.message).toContain("The phone is full.");
    expect(discarded).toEqual(["web/report"]);
  });

  test("a download still on its way can't be saved yet, and says so", async () => {
    const { daemon, sink, view, tabId } = await opened({
      write: async () => "",
      discard: async () => "",
    });
    daemon.browser.downloadAdd("web", {
      downloadId: "big",
      tabId: tabId(),
      filename: "big.zip",
      bytes: 10,
      mimeType: "application/zip",
      flags: [],
      state: "pending",
    });
    await until(
      () => (state(sink) as { downloads?: unknown[] } | null)?.downloads?.length === 1,
      "listed",
    );
    view.action({ kind: "save", downloadId: "big" });
    await until(() => sink.read("browser:problem") !== undefined, "refused");
    expect(sink.read("browser:problem")?.message).toBe(
      "That download hasn't finished on your computer yet.",
    );
  });

  test("the shown page can be put in the message as a mention, unless agents are kept out", async () => {
    const { sink, view, tabId } = await opened();
    await until(() => state(sink)?.shown?.mention != null, "mention");
    expect(state(sink)?.shown?.mention).toMatchObject({
      tabId: tabId(),
      url: "https://shop.test/cart",
    });
    view.action({ kind: "private", tabId: tabId(), value: true });
    await until(() => state(sink)?.shown?.mention === null, "kept out");
  });
});
