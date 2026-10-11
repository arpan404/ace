import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { EmbeddedBackend } from "@ace/browser";
import { BrowserBackend as DesktopBackend } from "./backend.ts";
import { fakeViews } from "./test-support.ts";
import { BrowserOpen, BrowserBackendClientMessage } from "@ace/protocol";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ace-large-policy-relay-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const views = fakeViews();
  const wire: BrowserBackendClientMessage[] = [];
  const desktop = new DesktopBackend(views.host, { log() {} });
  const relay = new EmbeddedBackend(
    "backend",
    {
      send: (message) => {
        desktop.handle(message);
        return true;
      },
      close() {
        desktop.detach();
      },
    },
    () => {},
  );
  desktop.attach({
    backendId: "backend",
    connectionId: "desktop",
    send: (serialized) => {
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(1024 * 1024);
      const message = BrowserBackendClientMessage.parse(JSON.parse(serialized));
      relay.handle(message);
      if (message.type === "browser.backend.event") wire.push(message);
      return true;
    },
  });
  onTestFinished(() => desktop.detach());
  const urls: string[] = [];
  const lost: string[] = [];
  const open = (threadId: string) =>
    relay.open({
      options: BrowserOpen.parse({ threadId, workspaceId: "workspace" }),
      profileDir: directory,
      signal: new AbortController().signal,
      allowed: async (url) => {
        urls.push(url);
        return url.endsWith("allowed");
      },
      navigation() {},
      log() {},
      lost: (reason) => {
        lost.push(reason);
      },
    });
  const session = await open("thread");
  onTestFinished(() => session.close());
  return { session, page: views.only(), views, wire, urls, lost, open };
}

it("a large embedded POST reaches origin policy and returns a decision without relaying its body", async () => {
  const { session, page, wire, urls } = await fixture();
  for (const requestId of ["allowed", "denied"])
    page.emit("Fetch.requestPaused", {
      requestId,
      frameId: "main",
      resourceType: "Fetch",
      futureMetadata: { retained: true },
      request: {
        url: `http://localhost/${requestId}`,
        method: "POST",
        postData: "x".repeat(1_100_000),
        postDataEntries: [{ bytes: "y".repeat(1_500_000) }],
        hasPostData: true,
      },
    });
  await vi.waitFor(
    () =>
      expect(
        page.calls.filter((call) =>
          ["Fetch.continueRequest", "Fetch.failRequest"].includes(call.method),
        ),
      ).toEqual([
        { method: "Fetch.continueRequest", params: { requestId: "allowed" } },
        {
          method: "Fetch.failRequest",
          params: { requestId: "denied", errorReason: "BlockedByClient" },
        },
      ]),
    { timeout: 1000 },
  );
  expect(urls).toEqual(["http://localhost/allowed", "http://localhost/denied"]);
  expect(JSON.stringify(wire)).not.toMatch(/postDataEntries|"postData"/);
  expect(wire).toContainEqual(
    expect.objectContaining({
      params: expect.objectContaining({ futureMetadata: { retained: true } }),
    }),
  );
  expect(await session.cdp.send("Page.getFrameTree")).toMatchObject({
    frameTree: { frame: { id: "main" } },
  });
});

it("policy metadata that still exceeds the relay bound explicitly loses its view while a sibling stays usable", async () => {
  const f = await fixture();
  const sibling = await f.open("sibling");
  onTestFinished(() => sibling.close());
  f.page.emit("Fetch.requestPaused", {
    requestId: "oversized",
    request: { url: "http://localhost/allowed" },
    futureMetadata: "x".repeat(1_100_000),
  });
  await vi.waitFor(() => expect(f.page.closed).toBe(true));
  expect(f.lost).toEqual(["Desktop browser view closed"]);
  expect(f.wire).toContainEqual(
    expect.objectContaining({
      method: "Inspector.detached",
      params: { reason: "Browser policy event payload limit" },
    }),
  );
  await expect(f.session.cdp.send("Page.getFrameTree")).rejects.toThrow("lost");
  expect(await sibling.cdp.send("Page.getFrameTree")).toMatchObject({
    frameTree: { frame: { id: "main" } },
  });
});
