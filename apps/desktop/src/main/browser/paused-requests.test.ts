import { expect, it } from "vitest";
import { PausedRequests } from "./paused-requests.ts";

function recorder() {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  return {
    sent,
    send: async (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      return {};
    },
  };
}

const nested = (sessionId: string, message: unknown) => ({
  sessionId,
  message: JSON.stringify(message),
});

it("refuses a load the daemon paused and never decided", async () => {
  const paused = new PausedRequests();
  paused.event("Fetch.requestPaused", { requestId: "r-1", request: { url: "https://a.test/" } });
  paused.event("Fetch.requestPaused", { requestId: "r-2", request: { url: "https://b.test/" } });
  paused.command("Fetch.continueRequest", { requestId: "r-1" });
  const cdp = recorder();
  await paused.refuseAll(cdp.send);
  expect(cdp.sent).toEqual([
    { method: "Fetch.failRequest", params: { requestId: "r-2", errorReason: "BlockedByClient" } },
  ]);
  // Refused once: a second refusal sends nothing.
  await paused.refuseAll(cdp.send);
  expect(cdp.sent).toHaveLength(1);
});

it("refuses a frame's paused load through the target that paused it", async () => {
  const paused = new PausedRequests();
  paused.event(
    "Target.receivedMessageFromTarget",
    nested("frame-1", {
      method: "Target.receivedMessageFromTarget",
      params: nested("frame-2", { method: "Fetch.requestPaused", params: { requestId: "f-1" } }),
    }),
  );
  const cdp = recorder();
  await paused.refuseAll(cdp.send);
  expect(cdp.sent).toHaveLength(1);
  const outer = cdp.sent[0];
  expect(outer).toMatchObject({
    method: "Target.sendMessageToTarget",
    params: { sessionId: "frame-1" },
  });
  const middle = JSON.parse(String(outer?.params.message));
  expect(middle).toMatchObject({
    method: "Target.sendMessageToTarget",
    params: { sessionId: "frame-2" },
  });
  expect(JSON.parse(middle.params.message)).toMatchObject({
    method: "Fetch.failRequest",
    params: { requestId: "f-1", errorReason: "BlockedByClient" },
  });
});

it("a decision the daemon sent into a frame settles that frame's request only", async () => {
  const paused = new PausedRequests();
  paused.event(
    "Target.receivedMessageFromTarget",
    nested("frame-1", { method: "Fetch.requestPaused", params: { requestId: "same" } }),
  );
  paused.event("Fetch.requestPaused", { requestId: "same" });
  paused.command(
    "Target.sendMessageToTarget",
    nested("frame-1", { id: 7, method: "Fetch.continueRequest", params: { requestId: "same" } }),
  );
  const cdp = recorder();
  await paused.refuseAll(cdp.send);
  expect(cdp.sent.map((entry) => entry.method)).toEqual(["Fetch.failRequest"]);
});

it("unrelated and malformed traffic is ignored", () => {
  const paused = new PausedRequests();
  paused.event("Network.requestWillBeSent", { requestId: "n-1" });
  paused.event("Fetch.requestPaused", { request: {} });
  paused.event("Target.receivedMessageFromTarget", { sessionId: "x", message: "{not json" });
  paused.event(
    "Target.receivedMessageFromTarget",
    nested("x", { method: "Runtime.consoleAPICalled", params: {} }),
  );
  expect(paused.size()).toBe(0);
});
