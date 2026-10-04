import { once, EventEmitter } from "node:events";
import { z } from "zod";
import { expect, it } from "vitest";
import { backendFixture } from "./backend-test-support.ts";
import { BrowserBackendRequest } from "@ace/protocol";

it("the embedded Fetch guard grants human top-level documents but never persists iframe or image origins", async () => {
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

it("an attached worker follows grants without granting its own origin under the human lease", async () => {
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
  if (!sessionId) throw new Error("Missing session");
  const commandSchema = z.object({
    id: z.number(),
    method: z.string(),
    params: z.unknown().optional(),
  });
  const workerCommands = new EventEmitter();
  f.requests.on("Target.sendMessageToTarget", (raw: unknown) => {
    const request = BrowserBackendRequest.parse(raw);
    if (request.operation.kind !== "cdp") return;
    const message = request.operation.params?.["message"];
    if (typeof message !== "string") throw new Error("Missing target command");
    const command = commandSchema.parse(JSON.parse(message));
    workerCommands.emit(command.method, command);
    f.sendEvent(sessionId, "Target.receivedMessageFromTarget", {
      sessionId: "worker",
      message: JSON.stringify({ id: command.id, result: {} }),
    });
  });
  const ready = once(workerCommands, "Runtime.runIfWaitingForDebugger");
  f.sendEvent(sessionId, "Target.attachedToTarget", {
    sessionId: "worker",
    targetInfo: { targetId: "worker-target", type: "worker" },
  });
  await ready;
  const continued = once(workerCommands, "Fetch.continueRequest");
  f.sendEvent(sessionId, "Target.receivedMessageFromTarget", {
    sessionId: "worker",
    message: JSON.stringify({
      method: "Fetch.requestPaused",
      params: {
        requestId: "worker-load",
        resourceType: "Document",
        frameId: "main",
        request: { url: "https://worker.example/script.js" },
      },
    }),
  });
  await continued;
  expect([...grants]).toEqual([]);
  f.service.handback("thread", "human");
  const failed = once(workerCommands, "Fetch.failRequest");
  f.sendEvent(sessionId, "Target.receivedMessageFromTarget", {
    sessionId: "worker",
    message: JSON.stringify({
      method: "Fetch.requestPaused",
      params: { requestId: "worker-denied", request: { url: "https://worker.example/data" } },
    }),
  });
  await failed;
});

it("takeover does not relabel a native agent redirect chain outside explicit navigation", async () => {
  const grants = new Set(["https://initial.example"]);
  const f = await backendFixture({
    originPolicy: (request) => {
      if (request.human && request.navigation) grants.add(request.origin);
      return grants.has(request.origin);
    },
  });
  await f.open();
  const sessionId = [...f.pages.keys()][0];
  if (!sessionId) throw new Error("Missing session");
  const continued = once(f.requests, "Fetch.continueRequest");
  f.sendEvent(sessionId, "Fetch.requestPaused", {
    requestId: "initial",
    resourceType: "Document",
    frameId: "main",
    request: { url: "https://initial.example/slow" },
  });
  await continued;
  f.service.takeover("thread", "human");
  const failed = once(f.requests, "Fetch.failRequest");
  f.sendEvent(sessionId, "Fetch.requestPaused", {
    requestId: "redirect",
    redirectedRequestId: "initial",
    resourceType: "Document",
    frameId: "main",
    request: { url: "https://new.example/final" },
  });
  expect(BrowserBackendRequest.parse((await failed)[0]).operation).toMatchObject({
    method: "Fetch.failRequest",
    params: { requestId: "redirect" },
  });
  expect([...grants]).toEqual(["https://initial.example"]);
});
