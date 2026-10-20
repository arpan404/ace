import { expect, it, onTestFinished } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { FakeHeadless, FakePage, backendFixture } from "./backend-test-support.ts";
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
    screenshot: async () => Buffer.from("public-seed"),
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
  const f = await backendFixture({
    headlessBackend: b.backend,
    backendPreference: () => "headless",
    now: () => now,
    ffmpeg: "/nonexistent",
  });
  await f.open();
  await f.service.startRecording("thread");
  await expect
    .poll(async () => {
      const paths = (await readdir(f.home, { recursive: true })).filter((path) =>
        path.endsWith("frames.jsonl"),
      );
      return Promise.all(paths.map((path) => readFile(join(f.home, path), "utf8"))).then(
        (contents) => contents.some((text) => text.endsWith("\n")),
      );
    })
    .toBe(true);
  const initial = b.pages[0];
  if (!initial) throw new Error("pages");
  now = 2000;
  keepAgentsOut(f.service, "thread");
  now = 3000;
  keepAgentsOut(f.service, "thread", false);
  now = 4000;
  initial.events.emit("Page.screencastFrame", {
    sessionId: 1,
    data: Buffer.from("PRIVATE-PIXELS").toString("base64"),
    metadata: { deviceWidth: 1280, deviceHeight: 720, timestamp: 2.5 },
  });
  now = 5000;
  initial.events.emit("Page.screencastFrame", {
    sessionId: 2,
    data: Buffer.from("public-after-handback").toString("base64"),
    metadata: { deviceWidth: 1280, deviceHeight: 720, timestamp: 4.5 },
  });
  await expect
    .poll(async () => {
      const paths = (await readdir(f.home, { recursive: true })).filter((path) =>
        path.endsWith(".jpg"),
      );
      const contents = await Promise.all(paths.map((path) => readFile(join(f.home, path), "utf8")));
      return contents.includes("public-after-handback");
    })
    .toBe(true);
  const artifact = await f.service.stopRecording("thread");
  expect(artifact.bytes).toBeGreaterThan(0);
  const paths = (await readdir(f.home, { recursive: true })).filter((path) =>
    path.endsWith(".jpg"),
  );
  const images = await Promise.all(paths.map((path) => readFile(join(f.home, path), "utf8")));
  expect(images).toContain("public-seed");
  expect(images).toContain("public-after-handback");
  expect(images.some((image) => image.includes("PRIVATE-PIXELS"))).toBe(false);
});
