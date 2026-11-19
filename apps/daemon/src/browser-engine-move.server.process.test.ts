import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { backendFixture, CountingHeadless } from "@ace/browser/testing";
import { BrowserBackendPreference } from "@ace/protocol";
import { SettingsService } from "@ace/settings";
import { BrowserClient } from "./browser-test-client.ts";
import { fixture, token } from "./socket-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

/** A daemon with a desktop app registered, real settings, and a thread showing one page. */
async function daemon() {
  const home = await mkdtemp(join(tmpdir(), "ace-engine-move-"));
  const settings = new SettingsService({ dataDir: home });
  const headless = new CountingHeadless();
  const machine = await backendFixture({
    headlessBackend: headless,
    // As the daemon's browser service reads it: the thread's resolved `browser.backend`.
    backendPreference: async (open) =>
      BrowserBackendPreference.parse(
        (await settings.get("browser.backend", { thread: open.threadId })).value,
      ),
  });
  const f = await fixture({ browser: machine.service, settings });
  cleanups.push(async () => {
    await f.close();
    await settings.close();
    await rm(home, { recursive: true, force: true });
  });
  const threadId = f.thread.id;
  const workspaceId = f.workspace;
  await machine.service.open({ threadId, workspaceId });
  await machine.service.execute(
    threadId,
    { action: "navigate", url: "https://one.example/", timeout: 5_000 },
    { kind: "human", connectionId: "setup" },
  );
  const device = async () => {
    const client = new BrowserClient(f.server.url);
    cleanups.push(() => client.close());
    await client.hello(token);
    return client;
  };
  const move = (client: BrowserClient, requestId: string, engine: string) =>
    client.request({ type: "browser.engine.move", requestId, threadId, workspaceId, engine });
  const kept = async () =>
    (await settings.read({ keys: ["browser.backend"], scope: { thread: threadId } })).entries[0];
  return { machine, headless, threadId, device, move, kept };
}

it("two devices moving one thread's browser at once leave one browser on that engine with its page loaded once", async () => {
  const d = await daemon();
  expect(d.machine.service.state(d.threadId).backend).toBe("embedded");
  const [phone, web] = [await d.device(), await d.device()];

  const replies = await Promise.all([
    d.move(phone, "phone-move", "headless"),
    d.move(web, "web-move", "headless"),
  ]);

  expect(replies).toEqual([
    expect.objectContaining({ ok: true }),
    expect.objectContaining({ ok: true }),
  ]);
  expect(d.machine.service.state(d.threadId)).toMatchObject({
    backend: "headless",
    closed: false,
    url: "https://one.example/",
  });
  expect(d.headless.opens).toHaveLength(1);
  expect(d.headless.loads).toEqual(["https://one.example/"]);
  expect(await d.kept()).toMatchObject({ value: "headless", provenance: "thread" });
});

it("a move to an engine that can't open leaves the thread's engine, setting and page in place", async () => {
  const d = await daemon();
  const phone = await d.device();
  expect(await d.move(phone, "to-headless", "headless")).toMatchObject({ ok: true });
  d.machine.failOpen("The desktop app has no window");

  const reply = await d.move(phone, "to-desktop", "embedded");

  expect(reply).toMatchObject({ ok: false, error: expect.stringMatching(/stayed where it was/) });
  expect(d.machine.service.state(d.threadId)).toMatchObject({
    backend: "headless",
    closed: false,
    url: "https://one.example/",
  });
  expect(await d.kept()).toMatchObject({ value: "headless" });
});
