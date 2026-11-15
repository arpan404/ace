import { afterEach, expect, it } from "vitest";
import { connectBrowser } from "./index.ts";
import { idleThread, settle } from "./idle-test-support.ts";
import type { PersonFile } from "./person-requests.ts";
import { defaultTabLifecycle } from "./tab-lifecycle.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const frozen = ["hide a", "freeze a", "show a", "thaw a"];

it.each([
  [
    "approving a certificate warning",
    { kind: "certificate", tabId: "a", url: "https://x/" },
    "certificate a",
  ],
  ["answering a sign-in", { kind: "auth", tabId: "a", authId: "auth-1" }, "auth a"],
  ["picking files", { kind: "files", tabId: "a", chooserId: "chooser", files: [] }, "files a"],
] as const)(
  "%s in a tab that froze unwatched reaches a shown, running page",
  async (_, request, step) => {
    const t = await idleThread();
    await t.idleFor(defaultTabLifecycle.freezeAfterMs);
    await t.service.asPerson("thread", request);
    expect(t.backend.steps("a")).toEqual([...frozen, step]);
    expect(t.lifecycle("a")).toBe("live");
  },
);

it("muting a frozen tab leaves its page frozen", async () => {
  const t = await idleThread();
  await t.idleFor(defaultTabLifecycle.freezeAfterMs);
  await t.service.asPerson("thread", { kind: "mute", tabId: "a", muted: true });
  expect(t.backend.steps("a")).toEqual(["hide a", "freeze a", "mute a"]);
});

it("files still being staged keep their tab awake until the page has them", async () => {
  const t = await idleThread();
  const arrived = Promise.withResolvers<void>();
  const file: PersonFile = {
    name: "report.txt",
    open: async () => ({
      chunks: (async function* () {
        await arrived.promise;
        yield new TextEncoder().encode("report");
      })(),
      close: async () => {},
    }),
  };
  const picking = t.service.asPerson("thread", {
    kind: "files",
    tabId: "a",
    chooserId: "chooser",
    files: [file],
  });
  await settle();
  // Past every idle limit while the upload is still arriving.
  await t.idleFor(defaultTabLifecycle.freezeAfterMs);
  arrived.resolve();
  await picking;
  expect(t.backend.steps("a")).toEqual(["files a"]);
  // Its idle time starts over once the page has the files.
  await t.idleFor(defaultTabLifecycle.restAfterMs - 1);
  expect(t.backend.steps("a")).toEqual(["files a"]);
});

it("a page that prints after resting is shown first, and is not frozen while its PDF is made", async () => {
  const t = await idleThread();
  await t.idleFor(defaultTabLifecycle.restAfterMs);
  const release = t.backend.hold("print a");
  t.backend.request?.print?.("a");
  await settle();
  await t.idleFor(defaultTabLifecycle.freezeAfterMs);
  await t.idleFor(defaultTabLifecycle.discardAfterMs);
  release();
  await expect.poll(() => t.backend.steps("a")).toEqual(["hide a", "show a", "print a"]);
});

it("a print that fails still lets its tab go idle afterwards", async () => {
  const t = await idleThread();
  t.backend.fail("print a");
  t.backend.request?.print?.("a");
  await settle();
  await t.idleFor(defaultTabLifecycle.restAfterMs);
  expect(t.backend.steps("a")).toEqual(["hide a"]);
});

it("a watched tab whose window would not show is tried again, its video saying so meanwhile", async () => {
  const t = await idleThread();
  await t.idleFor(defaultTabLifecycle.restAfterMs);
  t.backend.fail("show a", 2);
  const bridge = connectBrowser(t.service, {
    connectionId: "viewer",
    authorize: () => true,
    send: () => true,
    sendStream: () => true,
  });
  cleanups.push(async () => bridge.close());
  await bridge.handle({
    type: "browser.subscribe",
    threadId: "thread",
    requestId: "subscribe",
    binaryFrames: true,
    viewport: { width: 640, height: 400, devicePixelRatio: 1 },
    video: { codecs: ["vp8"] },
  });
  await expect
    .poll(() => t.service.state("thread").video)
    .toMatchObject({ status: "retrying", attempts: 1 });
  expect(t.service.state("thread").video?.reason).toContain("could not be shown");
  // The next try comes after a second, the one after that two seconds later.
  t.navigationClock.advance(1_000);
  await expect.poll(() => t.service.state("thread").video?.attempts).toBe(2);
  t.navigationClock.advance(1_999);
  await settle();
  expect(t.backend.steps("a")).toEqual(["hide a"]);
  t.navigationClock.advance(1);
  await expect.poll(() => t.backend.steps("a")).toEqual(["hide a", "show a"]);
  await expect.poll(() => t.service.state("thread").video).toBeUndefined();
});

it("a viewer that leaves stops the retries", async () => {
  const t = await idleThread();
  await t.idleFor(defaultTabLifecycle.restAfterMs);
  t.backend.fail("show a");
  const bridge = connectBrowser(t.service, {
    connectionId: "viewer",
    authorize: () => true,
    send: () => true,
    sendStream: () => true,
  });
  await bridge.handle({
    type: "browser.subscribe",
    threadId: "thread",
    requestId: "subscribe",
    binaryFrames: true,
    viewport: { width: 640, height: 400, devicePixelRatio: 1 },
    video: { codecs: ["vp8"] },
  });
  await expect.poll(() => t.service.state("thread").video?.status).toBe("retrying");
  bridge.close();
  await expect.poll(() => t.service.state("thread").video).toBeUndefined();
  t.navigationClock.advance(60_000);
  await settle();
  expect(t.backend.steps("a")).toEqual(["hide a"]);
});
