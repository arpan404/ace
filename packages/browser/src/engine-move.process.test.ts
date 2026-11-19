import { expect, it } from "vitest";
import { BrowserEngineMoved, type BrowserServerMessage } from "@ace/protocol";
import { connectBrowser, type EnginePreference } from "./index.ts";
import { backendFixture, CountingHeadless } from "./backend-test-support.ts";

/** A daemon whose thread engine setting lives in `kept`, with the person's two devices. */
async function machine(kept: EnginePreference | undefined) {
  const preferences = new Map<string, EnginePreference>();
  if (kept) preferences.set("thread", kept);
  const writes: EnginePreference[] = [];
  const headless = new CountingHeadless();
  const f = await backendFixture({
    headlessBackend: headless,
    backendPreference: (open) => preferences.get(open.threadId) ?? "auto",
  });
  const engine = {
    read: async (threadId: string) => preferences.get(threadId) ?? "auto",
    write: async (threadId: string, value: EnginePreference) => {
      writes.push(value);
      preferences.set(threadId, value);
    },
  };
  const device = (connectionId: string) => {
    const replies: BrowserServerMessage[] = [];
    const bridge = connectBrowser(f.service, {
      connectionId,
      authorize: () => true,
      send: (message) => {
        replies.push(message);
        return true;
      },
      engine,
    });
    return {
      async move(to: "embedded" | "headless") {
        const requestId = `${connectionId}-move`;
        await bridge.handle({
          type: "browser.engine.move",
          requestId,
          threadId: "thread",
          workspaceId: "workspace-thread",
          engine: to,
        });
        const reply = replies.find(
          (message) => message.type === "browser.result" && message.requestId === requestId,
        );
        if (reply?.type !== "browser.result") throw new Error("No reply");
        return reply;
      },
    };
  };
  const person = { kind: "human" as const, connectionId: "setup" };
  // The fake engines hold one tab each, so a thread's page is its shown tab.
  const load = async (url: string) => {
    await f.open();
    await f.service.execute("thread", { action: "navigate", url, timeout: 5_000 }, person);
  };
  /** The page the thread's browser shows. */
  const shown = () => f.service.state("thread").url;
  return { f, headless, preferences, writes, device, load, shown, person };
}

it("two devices moving one thread at once end with one browser there and its pages loaded once", async () => {
  const m = await machine(undefined);
  await m.load("https://one.example/");
  expect(m.f.service.state("thread").backend).toBe("embedded");

  const [phone, web] = await Promise.all([
    m.device("phone").move("headless"),
    m.device("web").move("headless"),
  ]);

  expect(phone).toMatchObject({ ok: true });
  expect(web).toMatchObject({ ok: true });
  const state = m.f.service.state("thread");
  expect(state).toMatchObject({ backend: "headless", closed: false });
  // One headless browser opened, its page loaded there once.
  expect(m.headless.opens).toHaveLength(1);
  expect(m.headless.loads).toEqual(["https://one.example/"]);
  expect(m.shown()).toBe("https://one.example/");
  expect(m.preferences.get("thread")).toBe("headless");
  expect(BrowserEngineMoved.parse(web.ok ? web.result : undefined).failed).toEqual([]);
});

it("a move to an engine that can't open leaves the previous engine and pages in place", async () => {
  const m = await machine("headless");
  await m.load("https://one.example/");
  m.f.failOpen("The desktop app has no window");

  const reply = await m.device("phone").move("embedded");

  expect(reply).toMatchObject({
    ok: false,
    error: expect.stringMatching(/stayed where it was\. .*no window/),
  });
  expect(m.f.service.state("thread")).toMatchObject({ backend: "headless", closed: false });
  expect(m.shown()).toBe("https://one.example/");
  expect(m.preferences.get("thread")).toBe("headless");
  // Opened for the page, then again after the failed move, loading the page there once more.
  expect(m.headless.opens).toHaveLength(2);
  expect(m.headless.loads).toEqual(["https://one.example/", "https://one.example/"]);
});

it("a thread without a browser keeps the choice for its next one and opens nothing", async () => {
  const m = await machine(undefined);

  const reply = await m.device("phone").move("headless");

  expect(reply).toMatchObject({ ok: true, result: { failed: [] } });
  expect(m.f.service.hasActiveSession("thread")).toBe(false);
  expect(m.writes).toEqual(["headless"]);
});
