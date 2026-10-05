import { once } from "node:events";
import { expect, it } from "vitest";
import { BrowserBackendRequest, type BrowserServerMessage } from "@ace/protocol";
import { BrowserOriginError, connectBrowser } from "./index.ts";
import { backendFixture } from "./backend-test-support.ts";
import { TestNavigationClock } from "./navigation-test-clock.ts";

it("redirect approval outlasts the ordinary load and relay deadlines without stopping a sibling session", async () => {
  const clock = new TestNavigationClock();
  const started = Promise.withResolvers<void>();
  const approval = Promise.withResolvers<boolean>();
  const f = await backendFixture({
    navigationClock: clock,
    origins: { list: () => [], grant() {}, revoke() {} },
    originPolicy: (request) => {
      if (request.origin !== "https://redirect.example") return true;
      started.resolve();
      return approval.promise;
    },
  });
  await f.open();
  await f.open("sibling");
  f.hold("Page.navigate");
  const requested = once(f.requests, "Page.navigate");
  const navigation = f.service.execute("thread", {
    action: "navigate",
    url: "http://localhost/slow",
    timeout: 10_000,
  });
  const message = BrowserBackendRequest.parse((await requested)[0]);
  f.sendEvent(message.sessionId, "Fetch.requestPaused", {
    requestId: "redirect",
    resourceType: "Document",
    frameId: "main",
    request: { url: "https://redirect.example/final" },
  });
  await started.promise;
  clock.advance(31_000);
  expect(f.service.state("thread").status).toBe("ready");
  expect(f.service.state("sibling").status).toBe("ready");
  f.releaseHold();
  expect(
    await f.service.execute("sibling", { action: "navigate", url: "http://localhost/sibling" }),
  ).toMatchObject({ url: "http://localhost/sibling" });
  const continued = once(f.requests, "Fetch.continueRequest");
  approval.resolve(true);
  await continued;
  f.sendEvent(message.sessionId, "Page.frameNavigated", {
    frame: { id: "main", url: "https://redirect.example/final" },
  });
  f.reply(message, { frameId: "main" });
  expect(await navigation).toMatchObject({ url: "https://redirect.example/final" });
});

it("a redirect refusal returns the matching typed block in both the public wire result and state", async () => {
  const f = await backendFixture({
    originPolicy: (request) => {
      if (request.origin === "https://denied.example")
        throw new BrowserOriginError(request.origin, "denied", "Browser origin approval denied");
      return true;
    },
  });
  await f.open();
  const messages: BrowserServerMessage[] = [];
  const wire = connectBrowser(f.service, {
    connectionId: "human",
    authorize: () => true,
    send: (message) => {
      messages.push(message);
      return true;
    },
  });
  await wire.handle({ type: "browser.takeover", requestId: "take", threadId: "thread" });
  await wire.handle({ type: "browser.subscribe", requestId: "subscribe", threadId: "thread" });
  f.hold("Page.navigate");
  const requested = once(f.requests, "Page.navigate");
  const navigation = wire.handle({
    type: "browser.execute",
    requestId: "visit",
    threadId: "thread",
    command: { action: "navigate", url: "http://localhost/slow" },
  });
  const message = BrowserBackendRequest.parse((await requested)[0]);
  const failed = once(f.requests, "Fetch.failRequest");
  f.sendEvent(message.sessionId, "Fetch.requestPaused", {
    requestId: "redirect",
    resourceType: "Document",
    frameId: "main",
    request: { url: "https://denied.example/final" },
  });
  await failed;
  f.reply(message, { frameId: "main", errorText: "net::ERR_BLOCKED_BY_CLIENT" });
  await navigation;
  expect(messages).toContainEqual(
    expect.objectContaining({
      type: "browser.result",
      requestId: "visit",
      ok: false,
      blocked: { origin: "https://denied.example", reason: "denied" },
    }),
  );
  expect(messages).toContainEqual(
    expect.objectContaining({
      type: "browser.state",
      state: expect.objectContaining({
        blocked: { origin: "https://denied.example", reason: "denied" },
      }),
    }),
  );
  f.releaseHold();
  await wire.handle({
    type: "browser.execute",
    requestId: "retry",
    threadId: "thread",
    command: { action: "navigate", url: "http://localhost/next" },
  });
  expect(messages).toContainEqual(
    expect.objectContaining({ type: "browser.result", requestId: "retry", ok: true }),
  );
  expect(f.service.state("thread").blocked).toBeUndefined();
  wire.close();
});

it("a command cancellation abandons redirected approval work but preserves sibling browsing", async () => {
  const clock = new TestNavigationClock();
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const f = await backendFixture({
    navigationClock: clock,
    origins: { list: () => [], grant() {}, revoke() {} },
    originPolicy: (request) => {
      if (request.origin !== "https://waiting.example") return true;
      started.resolve();
      return new Promise<boolean>((resolve) =>
        request.signal?.addEventListener(
          "abort",
          () => {
            cancelled.resolve();
            resolve(false);
          },
          { once: true },
        ),
      );
    },
  });
  await f.open();
  await f.open("sibling");
  f.hold("Page.navigate");
  const requested = once(f.requests, "Page.navigate");
  const signal = new AbortController();
  const failure = expect(
    f.service.execute(
      "thread",
      { action: "navigate", url: "http://localhost/slow" },
      { kind: "agent" },
      signal.signal,
    ),
  ).rejects.toThrow();
  const message = BrowserBackendRequest.parse((await requested)[0]);
  f.sendEvent(message.sessionId, "Fetch.requestPaused", {
    requestId: "redirect",
    resourceType: "Document",
    frameId: "main",
    request: { url: "https://waiting.example" },
  });
  await started.promise;
  signal.abort();
  await Promise.all([failure, cancelled.promise]);
  f.releaseHold();
  expect(
    await f.service.execute("sibling", { action: "navigate", url: "http://localhost/sibling" }),
  ).toMatchObject({ url: "http://localhost/sibling" });
});

it("the total approval reserve ends redirected navigation with a typed timeout and cancels the pending policy", async () => {
  const clock = new TestNavigationClock();
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const f = await backendFixture({
    navigationClock: clock,
    origins: { list: () => [], grant() {}, revoke() {} },
    originPolicy: (request) => {
      if (request.origin !== "https://waiting.example") return true;
      started.resolve();
      return new Promise<boolean>((resolve) =>
        request.signal?.addEventListener(
          "abort",
          () => {
            cancelled.resolve();
            resolve(false);
          },
          { once: true },
        ),
      );
    },
  });
  await f.open();
  f.hold("Page.navigate");
  const requested = once(f.requests, "Page.navigate");
  const failure = expect(
    f.service.execute("thread", {
      action: "navigate",
      url: "http://localhost/slow",
      timeout: 10_000,
    }),
  ).rejects.toMatchObject({ blocked: { origin: "https://waiting.example", reason: "timeout" } });
  const message = BrowserBackendRequest.parse((await requested)[0]);
  f.sendEvent(message.sessionId, "Fetch.requestPaused", {
    requestId: "redirect",
    resourceType: "Document",
    frameId: "main",
    request: { url: "https://waiting.example" },
  });
  await started.promise;
  clock.advance(75_000);
  await Promise.all([failure, cancelled.promise]);
  expect(f.service.state("thread").blocked).toEqual({
    origin: "https://waiting.example",
    reason: "timeout",
  });
});

it("a refusal from an older native request cannot replace the result of a newer explicit navigation", async () => {
  const entered = Promise.withResolvers<void>();
  const denial = Promise.withResolvers<boolean>();
  const f = await backendFixture({
    originPolicy: (request) => {
      if (request.origin !== "https://older.example") return true;
      entered.resolve();
      return denial.promise;
    },
  });
  await f.open();
  const sessionId = [...f.pages.keys()][0];
  if (!sessionId) throw new Error("Missing session");
  f.sendEvent(sessionId, "Fetch.requestPaused", {
    requestId: "older",
    resourceType: "Document",
    frameId: "main",
    request: { url: "https://older.example" },
  });
  await entered.promise;
  f.hold("Page.navigate");
  const requested = once(f.requests, "Page.navigate");
  const failure = expect(
    f.service.execute("thread", { action: "navigate", url: "http://localhost/newer" }),
  ).rejects.not.toHaveProperty("blocked");
  const message = BrowserBackendRequest.parse((await requested)[0]);
  const failed = once(f.requests, "Fetch.failRequest");
  denial.reject(new BrowserOriginError("https://older.example", "denied", "Old request denied"));
  await failed;
  f.reply(message, { frameId: "main", errorText: "net::ERR_FAILED" });
  await failure;
});
