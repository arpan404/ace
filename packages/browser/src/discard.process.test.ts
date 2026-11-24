import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it, onTestFinished } from "vitest";
import { fakeDelivery, phoneOwner } from "@ace/media/testing/fake-delivery";
import { connectBrowser } from "./index.ts";
import { defaultTabLifecycle } from "./tab-lifecycle.ts";
import { executablePath, fixture, ref } from "./test-support.ts";

/** A 440 Hz tone the page starts on a click (pages may only start sound after a gesture). */
const tone = `document.querySelector('button').addEventListener('click', () => {
  window.audioContext = new AudioContext();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.frequency.value = 440;
  gain.gain.value = 0.5;
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
});`;

/** A viewer whose view ace-media delivers, so its tab's capture starts and the extension loads. */
function mediaViewer(f: Awaited<ReturnType<typeof fixture>>) {
  const delivery = fakeDelivery();
  const bridge = connectBrowser(f.service, {
    connectionId: "viewer",
    authorize: () => true,
    send: () => true,
    media: { owner: () => phoneOwner, delivery: () => delivery.port },
  });
  return {
    subscribe: () =>
      bridge.handle({
        type: "browser.subscribe",
        threadId: "thread",
        requestId: "subscribe",
        subscriberId: "subscriber-1b4e28ba-2fa1-11d2-883f-0016d3cca427",
        binaryFrames: true,
        viewport: { width: 640, height: 400, devicePixelRatio: 2, audio: true },
        video: { codecs: ["avc1.42E033", "vp8"] },
        media: { connection: "mc_aaaaaaaaaaaa" },
      }),
    close: () => bridge.close(),
  };
}

/** ace's Chrome with a lifecycle timer the test fires, at a time the test sets. */
async function idleTabs() {
  const clock = { now: 0 };
  const ticks: (() => void)[] = [];
  const f = await fixture({
    now: () => clock.now,
    tabLifecycle: {
      policy: defaultTabLifecycle,
      every: 60_000,
      set: (_delay, work) => {
        ticks.push(work);
        return () => {};
      },
    },
  });
  const tab = f.service.state("thread").activeTabId;
  if (!tab) throw new Error("No tab");
  const lifecycle = () => f.service.state("thread").tabs?.find((entry) => entry.tabId === tab);
  /** Hours pass with the tab untouched, then the lifecycle timer looks. */
  const idleFor = (milliseconds: number) => {
    clock.now += milliseconds;
    ticks.shift()?.();
  };
  return { f, tab, lifecycle, idleFor };
}

/** A page with a download that keeps arriving until the test ends. */
async function slowDownload() {
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/big.bin") {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=big.bin",
        "Content-Length": String(64 * 1024 * 1024),
      });
      response.write(Buffer.alloc(64 * 1024));
      held.push(response);
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end('<a href="/big.bin" download>Big download</a>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    for (const response of held) response.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server address missing");
  return `http://127.0.0.1:${address.port}/`;
}

describe.skipIf(!executablePath)("idle tabs in ace's Chrome", () => {
  it("a tab idle past the discard threshold is dropped and reopens at its address, its page state lost", async () => {
    const { f, tab, lifecycle, idleFor } = await idleTabs();
    await f.execute({ action: "navigate", url: `${f.url}/kept`, tabId: tab });
    await f.execute({ action: "evaluate", tabId: tab, expression: "window.marker = 'before'" });
    // Another tab takes the view, so this one is idle and unseen.
    await f.execute({ action: "tabs", operation: "open" });

    idleFor(defaultTabLifecycle.discardAfterMs + 1);
    await expect.poll(() => lifecycle()?.lifecycle).toBe("discarded");
    expect(lifecycle()?.url).toBe(`${f.url}/kept`);

    expect(
      await f.execute({
        action: "evaluate",
        tabId: tab,
        expression: "[location.pathname, typeof window.marker]",
      }),
    ).toEqual(["/kept", "undefined"]);
    expect(lifecycle()).toMatchObject({ lifecycle: "live", pageStateLost: true });
  }, 60_000);

  // A tab that played sound keeps what the extension last said until it is dropped: unbinding
  // must clear it, or a discarded tab lists sound (and a mute) it no longer has.
  it("a discarded tab stops listing the sound it had", async () => {
    const { f, tab, lifecycle, idleFor } = await idleTabs();
    await f.execute({ action: "navigate", url: f.url, tabId: tab });
    await f.execute({ action: "evaluate", tabId: tab, expression: tone });
    const save = ref(await f.execute({ action: "snapshot", tabId: tab }), "Save");
    await f.execute({ action: "click", tabId: tab, ref: save });
    await expect
      .poll(() =>
        f.execute({ action: "evaluate", tabId: tab, expression: "window.audioContext?.state" }),
      )
      .toBe("running");
    const viewer = mediaViewer(f);
    await viewer.subscribe();
    await expect.poll(() => lifecycle()?.audible, { timeout: 15_000 }).toBe(true);
    await f.service.asPerson("thread", { kind: "mute", tabId: tab, muted: true });
    await expect.poll(() => lifecycle()?.muted, { timeout: 15_000 }).toBe(true);

    // Another tab takes the view, so this one is idle and unseen: it is dropped.
    await f.execute({ action: "tabs", operation: "open" });
    idleFor(defaultTabLifecycle.discardAfterMs + 1);
    await expect.poll(() => lifecycle()?.lifecycle).toBe("discarded");
    expect(lifecycle()?.audible).toBeUndefined();
    expect(lifecycle()?.muted).toBeUndefined();
    viewer.close();
  }, 60_000);

  it("a tab with a download still arriving is neither frozen nor discarded", async () => {
    const { f, tab, lifecycle, idleFor } = await idleTabs();
    await f.execute({ action: "navigate", url: await slowDownload(), tabId: tab });
    await f.execute({
      action: "evaluate",
      tabId: tab,
      expression: "document.querySelector('a').click()",
    });
    await expect
      .poll(() => f.service.downloadsList("thread").map((download) => download.state))
      .toEqual(["pending"]);
    await f.execute({ action: "tabs", operation: "open" });

    idleFor(defaultTabLifecycle.discardAfterMs + 1);
    // Give the lifecycle pass time to act, had it wanted to.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(lifecycle()?.lifecycle).toBe("live");
    expect(f.service.downloadsList("thread").map((download) => download.state)).toEqual([
      "pending",
    ]);
  }, 60_000);
});
