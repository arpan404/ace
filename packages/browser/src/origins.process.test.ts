import { once } from "node:events";
import { expect, it } from "vitest";
import { backendFixture } from "./backend-test-support.ts";
import { BrowserBackendRequest } from "@ace/protocol";

it("the embedded Fetch guard grants human top-level redirects but never persists iframe or worker origins", async () => {
  const grants = new Set<string>();
  const f = await backendFixture({
    originPolicy: (request) => {
      if (request.human && request.navigation) grants.add(request.origin);
      return request.human === true || grants.has(request.origin);
    },
  });
  await f.open();
  f.service.takeover("thread", "human");
  const sessionId = [...f.pages.keys()][0];
  if (!sessionId) throw new Error("Missing desktop session");
  const document = once(f.requests, "Fetch.continueRequest");
  f.sendEvent(sessionId, "Fetch.requestPaused", {
    requestId: "document",
    resourceType: "Document",
    frameId: "main",
    request: { url: "https://youtube.com/watch" },
  });
  expect(BrowserBackendRequest.parse((await document)[0]).operation).toMatchObject({
    method: "Fetch.continueRequest",
    params: { requestId: "document" },
  });
  const iframe = once(f.requests, "Fetch.continueRequest");
  f.sendEvent(sessionId, "Fetch.requestPaused", {
    requestId: "iframe",
    resourceType: "Document",
    frameId: "child",
    request: { url: "https://frame.example/" },
  });
  await iframe;
  const image = once(f.requests, "Fetch.continueRequest");
  f.sendEvent(sessionId, "Fetch.requestPaused", {
    requestId: "image",
    resourceType: "Image",
    frameId: "main",
    request: { url: "https://cdn.example/" },
  });
  await image;
  expect([...grants]).toEqual(["https://youtube.com"]);
  f.service.handback("thread", "human");
  const refused = once(f.requests, "Fetch.failRequest");
  f.sendEvent(sessionId, "Fetch.requestPaused", {
    requestId: "refused",
    resourceType: "Image",
    frameId: "main",
    request: { url: "https://cdn.example/" },
  });
  expect(BrowserBackendRequest.parse((await refused)[0]).operation).toMatchObject({
    method: "Fetch.failRequest",
    params: { errorReason: "BlockedByClient" },
  });
});
it("an embedded WebSocket handshake checks current HTTP-equivalent grants and rejects after revoke", async () => {
  const grants = new Set(["https://youtube.com"]);
  const f = await backendFixture({ originPolicy: (request) => grants.has(request.origin) });
  await f.open();
  const sessionId = [...f.pages.keys()][0];
  if (!sessionId) throw new Error("Missing desktop session");
  const approved = once(f.requests, "ace.webSocketDecision");
  f.sendEvent(sessionId, "ace.webSocketRequested", { id: "one", url: "wss://youtube.com/live" });
  expect(BrowserBackendRequest.parse((await approved)[0]).operation).toMatchObject({
    params: { id: "one", allowed: true },
  });
  grants.clear();
  const denied = once(f.requests, "ace.webSocketDecision");
  f.sendEvent(sessionId, "ace.webSocketRequested", { id: "two", url: "wss://youtube.com/live" });
  expect(BrowserBackendRequest.parse((await denied)[0]).operation).toMatchObject({
    params: { id: "two", allowed: false },
  });
});
