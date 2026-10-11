import { expect, it } from "vitest";
import { originFixture } from "./browser-origin-test-support.ts";

it.each(["allow_once", "allow_thread"])(
  "revocation fences a resolved %s approval before its continuation can restore access",
  async (choice) => {
    const f = await originFixture();
    const origins = f.context.services.browserOrigins;
    if (!origins) throw new Error("Browser origins unavailable");
    const request = {
      threadId: f.thread.id,
      origin: "https://site.example",
      url: "https://site.example/page",
      navigation: true,
    };
    const opened = f.opened();
    const admission = origins.allowed(request);
    const rejected = expect(admission).rejects.toMatchObject({ blocked: { reason: "denied" } });
    expect(f.resolve(await opened, choice).ok).toBe(true);
    origins.revoke(f.thread.id, request.origin);
    expect(origins.list(f.thread.id)).toEqual([]);
    await rejected;
    expect(origins.list(f.thread.id)).toEqual([]);
    const backend = f.headless.opens[0];
    if (!backend) throw new Error("Browser backend unavailable");
    expect(await backend.allowed("https://site.example/resource")).toBe(false);
    expect(await backend.allowed("wss://site.example/socket")).toBe(false);
    const freshOpened = f.opened();
    const fresh = origins.allowed(request);
    expect(f.resolve(await freshOpened, "allow_once").ok).toBe(true);
    expect(await fresh).toBe(true);
    expect(await backend.allowed("wss://site.example/socket")).toBe(true);
  },
);

it("page reset fences a resolved page approval while a fresh approval remains usable", async () => {
  const f = await originFixture();
  const origins = f.context.services.browserOrigins;
  if (!origins) throw new Error("Browser origins unavailable");
  const request = {
    threadId: f.thread.id,
    origin: "https://site.example",
    url: "https://site.example/page",
    navigation: true,
  };
  const opened = f.opened();
  const admission = origins.allowed(request);
  const rejected = expect(admission).rejects.toMatchObject({ blocked: { reason: "denied" } });
  expect(f.resolve(await opened, "allow_once").ok).toBe(true);
  origins.clearPage(f.thread.id);
  await rejected;
  expect(origins.list(f.thread.id)).toEqual([]);
  const freshOpened = f.opened();
  const fresh = origins.allowed(request);
  expect(f.resolve(await freshOpened, "allow_once").ok).toBe(true);
  expect(await fresh).toBe(true);
});
