import type { ClientApi } from "@ace/client";
import { maxSpadeRequestBytes } from "@ace/protocol";
import { expect, test } from "vitest";
import { desktopSpade, type DesktopSpade, type DirectAnswer } from "./desktop-spade.ts";
import { spadeBlob, spadeHttp, SpadeRequestError } from "./spade-requests.ts";
import { SpadeTransport } from "./spade-transport.ts";

/** A daemon connection that records what it is asked and answers every `spade.http` with 200. */
function daemon() {
  const asked: { type: string; path?: string; parts?: number }[] = [];
  const client = {
    state: "ready",
    connectionState: () => ({ getSnapshot: () => "ready", subscribe: () => () => {} }),
    connectionGeneration: () => ({ getSnapshot: () => 1, subscribe: () => () => {} }),
    onMessage: () => () => {},
    send: () => {},
    request: async (input: { type: string; path?: string }, options?: { requestId?: string }) => {
      asked.push(input);
      return {
        type: "spade.http.result",
        requestId: options?.requestId ?? "",
        result: { kind: "response", status: 200, body: '"daemon"', encoding: "text" },
      };
    },
  };
  // Only these members of the client are used on the daemon's way.
  return { client: client as unknown as ClientApi, asked };
}

/** `window.ace.spade` answering every request with `answer`, recording what it was sent. */
function desktop(answer: DirectAnswer) {
  const sent: { path: string; body?: string | undefined }[] = [];
  const spade: DesktopSpade = {
    available: async () => true,
    health: async () => ({ version: "0.4.0" }),
    request: async ({ path, body }) => {
      sent.push({ path, body });
      return answer;
    },
    openLive: async () => {},
    closeLive: async () => {},
    onLive: () => () => {},
    onEndpointChanged: () => () => {},
  };
  return { spade, sent };
}

const deps = { id: () => crypto.randomUUID(), now: () => 0 };
const ok = (body: string): DirectAnswer => ({
  kind: "text",
  status: 200,
  contentType: "application/json",
  body,
});

test("an upload goes straight to Spade as one request carrying the whole body", async () => {
  const { client, asked } = daemon();
  const direct = desktop(ok('{"id":"c1"}'));
  const transport = new SpadeTransport(client, direct.spade, deps);
  const images = [{ data: "A".repeat(maxSpadeRequestBytes * 2) }];
  const body = await spadeHttp(transport, "POST", "/v1/conversations", {
    body: { text: "look", images },
  });
  expect(body).toBe('{"id":"c1"}');
  expect(direct.sent).toEqual([
    { path: "/v1/conversations", body: JSON.stringify({ text: "look", images }) },
  ]);
  expect(asked).toEqual([]);
});

test("an image loads as a blob of Spade's own bytes", async () => {
  const { client } = daemon();
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const direct = desktop({ kind: "bytes", status: 200, contentType: "image/png", body: bytes });
  const blob = await spadeBlob(new SpadeTransport(client, direct.spade, deps), "/v1/images/abc");
  expect(blob.type).toBe("image/png");
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
});

test("a direct request cut off after it may have reached Spade is never sent again", async () => {
  const { client, asked } = daemon();
  const direct = desktop({ kind: "error", code: "failed", message: "Spade didn't answer." });
  const transport = new SpadeTransport(client, direct.spade, deps);
  const sending = spadeHttp(transport, "POST", "/v1/conversations/c1/messages", {
    body: { text: "hi" },
  });
  await expect(sending).rejects.toSatisfy(
    (error) => error instanceof SpadeRequestError && error.unanswered,
  );
  expect(asked).toEqual([]);
});

test("outside the desktop app, Spade is reached through the daemon", async () => {
  const { client, asked } = daemon();
  const transport = new SpadeTransport(client, desktopSpade({}), deps);
  expect(await spadeHttp(transport, "GET", "/v1/models")).toBe('"daemon"');
  expect(asked.map((message) => message.path)).toEqual(["/v1/models"]);
});

test("Spade's status comes from its own health in the desktop app", async () => {
  const { client } = daemon();
  const direct = desktop(ok("{}"));
  expect(await new SpadeTransport(client, direct.spade, deps).health()).toEqual({
    version: "0.4.0",
  });
  expect(await new SpadeTransport(client, undefined, deps).health()).toBeUndefined();
});

test("an answer from the app that isn't one of the bridge's shapes is a failure, not a crash", async () => {
  const { client } = daemon();
  const bridge = {
    ace: {
      spade: {
        endpoint: async () => ({ address: "127.0.0.1:4100", version: "1", api: 1 }),
        health: async () => null,
        request: async () => ({ kind: "text", status: "200", body: 4 }),
        openLive: async () => {},
        closeLive: async () => {},
        onLive: () => () => {},
        onEndpointChanged: () => () => {},
      },
    },
  };
  const transport = new SpadeTransport(client, desktopSpade(bridge), deps);
  await expect(spadeHttp(transport, "GET", "/v1/models")).rejects.toBeInstanceOf(SpadeRequestError);
});
