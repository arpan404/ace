import { FakeMediaRecorder } from "@ace/media/testing/fake-recorder";
import { expect, it, onTestFinished } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { FakeHeadless, FakePage, backendFixture, markedJpeg } from "./backend-test-support.ts";
import { keepAgentsOut } from "./collaboration-test-support.ts";

function tabBackend() {
  const backend = new FakeHeadless(),
    open = backend.open.bind(backend);
  const pages = [new FakePage(), new FakePage()];
  let active = 0;
  const effects: string[] = [];
  backend.open = async (request) => ({
    ...(await open(request)),
    get cdp() {
      return (
        pages[active]?.cdp ??
        (() => {
          throw new Error("active page");
        })()
      );
    },
    wheel: async () => {
      effects.push("wheel");
    },
    resize: async () => {
      effects.push("resize");
    },
    media: async () => {
      effects.push("media");
    },
    screenshot: async () => markedJpeg(1),
    tabs: {
      list: () => pages.map((_page, n) => ({ tabId: `tab-${n}`, url: "about:blank", title: "" })),
      active: () => `tab-${active}`,
      open: async () => {
        throw new Error("fixture has two tabs");
      },
      switch: async (id) => {
        active = id === "tab-1" ? 1 : 0;
        request.changed?.();
      },
      close: async () => {},
      dialog: () => undefined,
      answer: async () => {},
      downloads: () => [],
    },
  });
  return { backend, pages, effects };
}

it.each(["resize", "metrics", "touch"] as const)(
  "emulation stops subsequent effects when the tab turns private across %s",
  async (barrier) => {
    const backend = new FakeHeadless(),
      open = backend.open.bind(backend);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    onTestFinished(() => release.resolve());
    const effects: string[] = [];
    const effect = async (name: string) => {
      effects.push(name);
      if (name === barrier) {
        entered.resolve();
        await release.promise;
      }
    };
    backend.open = async (request) => {
      const session = await open(request),
        send = session.cdp.send;
      return {
        ...session,
        cdp: {
          ...session.cdp,
          send: async (method, params) => {
            if (method === "Emulation.setDeviceMetricsOverride") await effect("metrics");
            if (method === "Emulation.setTouchEmulationEnabled") await effect("touch");
            return send(method, params);
          },
        },
        resize: () => effect("resize"),
        media: () => effect("media"),
      };
    };
    const f = await backendFixture({
      headlessBackend: backend,
      backendPreference: () => "headless",
    });
    await f.open();
    const command = {
      action: "emulate",
      width: 800,
      height: 600,
      mobile: true,
      touch: true,
      deviceScaleFactor: 2,
      colorScheme: "dark",
    };
    const rejected = expect(f.service.execute("thread", command)).rejects.toMatchObject({
      code: "human_private",
    });
    await entered.promise;
    keepAgentsOut(f.service, "thread");
    keepAgentsOut(f.service, "thread", false);
    release.resolve();
    await rejected;
    expect(effects).toEqual(
      barrier === "resize"
        ? ["resize"]
        : barrier === "metrics"
          ? ["resize", "metrics"]
          : ["resize", "metrics", "touch"],
    );
    effects.length = 0;
    await f.service.execute("thread", command);
    expect(effects).toEqual(["resize", "metrics", "touch", "media"]);
  },
);

it("a delayed screencast frame captured while the tab was private never enters the recording after agents are let back in", async () => {
  const b = tabBackend();
  let now = 1000;
  const recorder = new FakeMediaRecorder();
  const f = await backendFixture({
    headlessBackend: b.backend,
    backendPreference: () => "headless",
    now: () => now,
    recorder,
  });
  await f.open();
  await f.service.startRecording("thread");
  const recorded = () => recorder.last()?.units.map((unit) => unit.height) ?? [];
  // The recording's first picture, the page's own screenshot.
  await expect.poll(recorded).toEqual([1]);
  const initial = b.pages[0];
  if (!initial) throw new Error("pages");
  now = 2000;
  keepAgentsOut(f.service, "thread");
  now = 3000;
  keepAgentsOut(f.service, "thread", false);
  now = 4000;
  // Captured at 2.5 s, while private, and delivered after the hand-back.
  initial.events.emit("Page.screencastFrame", {
    sessionId: 1,
    data: markedJpeg(9).toString("base64"),
    metadata: { deviceWidth: 1280, deviceHeight: 720, timestamp: 2.5 },
  });
  now = 5000;
  initial.events.emit("Page.screencastFrame", {
    sessionId: 2,
    data: markedJpeg(5).toString("base64"),
    metadata: { deviceWidth: 1280, deviceHeight: 720, timestamp: 4.5 },
  });
  await expect.poll(recorded).toEqual([1, 5]);
  const artifact = await f.service.stopRecording("thread");
  expect(artifact.bytes).toBeGreaterThan(0);
  expect(recorded()).not.toContain(9);
});

it.each([
  ["moved on", "https://mail.google.com/mail/u/0", "place_changed"],
  ["stayed", "https://docs.example/guide", undefined],
] as const)(
  "an input queued behind another runs only while its tab is still where its caller checked (%s)",
  async (_case, after, refused) => {
    const backend = new FakeHeadless(),
      open = backend.open.bind(backend);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    onTestFinished(() => release.resolve());
    backend.open = async (request) => ({
      ...(await open(request)),
      // The first input holds the tab's queue until the test lets it go.
      wheel: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const f = await backendFixture({
      headlessBackend: backend,
      backendPreference: () => "headless",
    });
    await f.open();
    const page = backend.pages.at(-1);
    if (!page) throw new Error("no page");
    page.url = "https://docs.example/guide";
    const tabId = f.service.state("thread").activeTabId ?? "page";
    const scrolling = f.service.execute("thread", { action: "scroll", x: 0, y: 10 });
    await entered.promise;
    // A ref-less Enter, checked on docs.example, waits its turn while the page moves on.
    const pressing = f.service.execute("thread", {
      action: "press",
      key: "Enter",
      expect: { tabId, url: "https://docs.example/guide" },
    });
    page.url = after;
    release.resolve();
    await scrolling;
    if (refused) {
      await expect(pressing).rejects.toMatchObject({ code: refused });
      expect(page.effects).not.toContain("key");
    } else {
      await pressing;
      expect(page.effects).toContain("key");
    }
  },
);

it("an input bound to another tab never runs in this one, at the same address", async () => {
  const f = await backendFixture({ backendPreference: () => "headless" });
  await f.open();
  const page = f.headless.pages.at(-1);
  if (!page) throw new Error("no page");
  page.url = "https://docs.example/guide";
  await expect(
    f.service.execute("thread", {
      action: "press",
      key: "Enter",
      expect: { tabId: "another-tab", url: "https://docs.example/guide" },
    }),
  ).rejects.toMatchObject({ code: "place_changed" });
  expect(page.effects).not.toContain("key");
});

it("going back checks the place after reading the history, right before the move", async () => {
  const backend = new FakeHeadless(),
    open = backend.open.bind(backend);
  const moves: string[] = [];
  backend.open = async (request) => {
    const session = await open(request),
      send = session.cdp.send;
    return {
      ...session,
      cdp: {
        ...session.cdp,
        send: async (method: string, params?: Record<string, unknown>) => {
          if (method === "Page.getNavigationHistory") {
            // The page moves on while the history is read.
            const page = backend.pages.at(-1);
            if (page) page.url = "https://mail.google.com/mail/u/0";
            return {
              currentIndex: 1,
              entries: [
                { id: 1, url: "https://docs.example/a", title: "" },
                { id: 2, url: "https://docs.example/b", title: "" },
              ],
            };
          }
          return send(method, params);
        },
      },
    };
  };
  const f = await backendFixture({ headlessBackend: backend, backendPreference: () => "headless" });
  await f.open();
  const page = backend.pages.at(-1);
  if (!page) throw new Error("no page");
  page.url = "https://docs.example/b";
  page.onSend = (method) => {
    if (method === "Page.navigateToHistoryEntry") moves.push(method);
  };
  const tabId = f.service.state("thread").activeTabId ?? "page";
  await expect(
    f.service.execute("thread", {
      action: "history",
      direction: "back",
      expect: { tabId, url: "https://docs.example/b" },
    }),
  ).rejects.toMatchObject({ code: "place_changed" });
  expect(moves).toEqual([]);
});

it("closing or keeping a tab acts only on the tab the caller checked, at its address", async () => {
  const { backend } = tabBackend();
  const closed: string[] = [];
  const open = backend.open.bind(backend);
  backend.open = async (request) => {
    const session = await open(request);
    if (!session.tabs) throw new Error("tabs");
    const tabs = session.tabs;
    return {
      ...session,
      tabs: {
        ...tabs,
        close: async (id: string) => {
          closed.push(id);
        },
      },
    };
  };
  const f = await backendFixture({ headlessBackend: backend, backendPreference: () => "headless" });
  await f.open();
  // tab-0 is on the person's mail now, though the caller checked it on docs.example.
  const page = backend.pages.at(-1);
  if (!page) throw new Error("no page");
  page.url = "https://mail.google.com/mail/u/0";
  for (const operation of ["close", "keep", "select"]) {
    await expect(
      f.service.execute("thread", {
        action: "tabs",
        operation,
        tabId: "tab-0",
        expect: { tabId: "tab-0", url: "https://docs.example/" },
      }),
    ).rejects.toMatchObject({ code: "place_changed" });
  }
  expect(closed).toEqual([]);
  // Checked where it is, it closes.
  await f.service.execute("thread", {
    action: "tabs",
    operation: "close",
    tabId: "tab-0",
    expect: { tabId: "tab-0", url: "https://mail.google.com/mail/u/0" },
  });
  expect(closed).toEqual(["tab-0"]);
});

it("a double click whose first click navigates never sends its second click to the new page", async () => {
  const f = await backendFixture({ backendPreference: () => "headless" });
  await f.open();
  const page = f.headless.pages.at(-1);
  if (!page) throw new Error("no page");
  page.url = "https://docs.example/guide";
  // What reached the page: the first press follows a link to the person's settings.
  const sent: string[] = [];
  page.onSend = (method, params) => {
    if (method !== "Input.dispatchMouseEvent") return;
    sent.push(`${String(params?.["type"])}:${String(params?.["clickCount"] ?? "")}`);
    if (params?.["type"] === "mousePressed") page.url = "https://docs.example/settings";
  };
  const tabId = f.service.state("thread").activeTabId ?? "page";
  await expect(
    f.service.execute("thread", {
      action: "click",
      x: 10,
      y: 10,
      clickCount: 2,
      expect: { tabId, url: "https://docs.example/guide" },
    }),
  ).rejects.toMatchObject({ code: "place_changed" });
  // Its release and the whole second click never reached the settings page.
  expect(sent).toEqual(["mouseMoved:", "mousePressed:1"]);
});
