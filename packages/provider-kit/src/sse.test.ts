import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { readSse, type SseEvent } from "./sse.ts";

const servers: Server[] = [];
const controllers: AbortController[] = [];
async function server(listener: RequestListener) {
  const http = createServer(listener);
  servers.push(http);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  return `http://127.0.0.1:${address.port}/global/event`;
}
function controller() {
  const result = new AbortController();
  controllers.push(result);
  return result;
}
afterEach(async () => {
  controllers.splice(0).forEach((c) => c.abort());
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve, reject) => {
          s.closeAllConnections();
          s.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("fetch SSE", () => {
  it("dispatches multiline data, event types and persistent ids while ignoring comments", async () => {
    const url = await server((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        "\uFEFF: comment\r\nid: abc\revent: update\ndata: hello\r\ndata:  world\r\n\r\ndata:\n\nid: invalid\0id\ndata: last\n\ndata: incomplete",
      );
    });
    const events: SseEvent[] = [];
    await readSse(url, {
      signal: controller().signal,
      reconnect: false,
      onEvent: (event) => events.push(event),
    });
    expect(events).toEqual([
      { event: "update", id: "abc", data: "hello\n world" },
      { event: "message", id: "abc", data: "" },
      { event: "message", id: "abc", data: "last" },
    ]);
  });
  it("handles a CRLF split across network chunks without adding a blank event", async () => {
    let nextChunk: (() => void) | undefined;
    const url = await server((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      nextChunk = () => res.end("\ndata: second\r\n\r\n");
      res.write("data: first\n\ndata: second-start\r");
    });
    const events: SseEvent[] = [];
    await readSse(url, {
      signal: controller().signal,
      reconnect: false,
      onEvent: (event) => {
        events.push(event);
        if (event.data === "first") nextChunk?.();
      },
    });
    expect(events.map((event) => event.data)).toEqual(["first", "second-start\nsecond"]);
  });
  it("aborting a live stream closes the HTTP connection and resolves the reader", async () => {
    const abort = controller();
    let disconnected: Promise<unknown> = Promise.resolve();
    const url = await server((_, res) => {
      disconnected = once(res, "close");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: ready\n\n");
    });
    const events: string[] = [];
    await readSse(url, {
      signal: abort.signal,
      onEvent: ({ data }) => {
        events.push(data);
        abort.abort();
      },
    });
    await disconnected;
    expect(events).toEqual(["ready"]);
  });
  it("reconnects after EOF, reports backoff and resumes using the last complete event id", async () => {
    const abort = controller();
    const observedHeaders: Array<string | string[] | undefined> = [];
    const url = await server((req, res) => {
      observedHeaders.push(req.headers["last-event-id"]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        observedHeaders.length === 1
          ? "id: resume\nretry: 2\ndata: first\n\nid: unfinished\ndata: dropped"
          : "data: second\n\n",
      );
    });
    const events: string[] = [];
    const reconnects: Array<{ attempt: number; delayMs: number }> = [];
    await readSse(url, {
      signal: abort.signal,
      reconnect: { initialDelayMs: 1, maxDelayMs: 10 },
      onReconnect: (info) => reconnects.push(info),
      onEvent: ({ data }) => {
        events.push(data);
        if (data === "second") abort.abort();
      },
    });
    expect(events).toEqual(["first", "second"]);
    expect(observedHeaders).toEqual([undefined, "resume"]);
    expect(reconnects).toEqual([{ attempt: 1, delayMs: 2 }]);
  });
  it("backs off repeated HTTP failures, preserves auth headers and caps the delay", async () => {
    const abort = controller();
    const auth: Array<string | undefined> = [];
    const url = await server((req, res) => {
      auth.push(req.headers["authorization"]);
      if (auth.length < 4) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: recovered\n\n");
    });
    const reconnects: number[] = [];
    const events: string[] = [];
    await readSse(url, {
      signal: abort.signal,
      headers: { authorization: "Basic synthetic" },
      reconnect: { initialDelayMs: 2, maxDelayMs: 5 },
      onReconnect: ({ delayMs }) => reconnects.push(delayMs),
      onEvent: ({ data }) => {
        events.push(data);
        abort.abort();
      },
    });
    expect(events).toEqual(["recovered"]);
    expect(reconnects).toEqual([2, 4, 5]);
    expect(auth).toEqual([
      "Basic synthetic",
      "Basic synthetic",
      "Basic synthetic",
      "Basic synthetic",
    ]);
  });
  it("reports a heartbeat gap even while other events arrive", async () => {
    const abort = controller();
    const url = await server((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"payload":{"type":"server.heartbeat"}}\n\n');
      const traffic = setInterval(
        () => res.write('data: {"payload":{"type":"session.status"}}\n\n'),
        5,
      );
      res.on("close", () => clearInterval(traffic));
    });
    const gaps: number[] = [];
    await readSse(url, {
      signal: abort.signal,
      heartbeat: {
        gapMs: 50,
        isHeartbeat: ({ data }) => data.includes("server.heartbeat"),
        onGap: (elapsed) => {
          gaps.push(elapsed);
          abort.abort();
        },
      },
      onEvent: () => {},
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toBeGreaterThanOrEqual(45);
  });
  it("rejects event and heartbeat handler failures instead of reconnecting or throwing outside the reader", async () => {
    const url = await server((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: ready\n\n");
    });
    await expect(
      readSse(url, {
        signal: controller().signal,
        onEvent: () => {
          throw new Error("event handler failed");
        },
      }),
    ).rejects.toThrow("event handler failed");
    await expect(
      readSse(url, {
        signal: controller().signal,
        onEvent: () => {},
        heartbeat: {
          gapMs: 20,
          onGap: () => {
            throw new Error("gap handler failed");
          },
        },
      }),
    ).rejects.toThrow("gap handler failed");
  });
  it("stops dispatching buffered events as soon as the caller aborts", async () => {
    const abort = controller();
    const url = await server((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: first\n\ndata: after-abort\n\n");
    });
    const events: string[] = [];
    await readSse(url, {
      signal: abort.signal,
      onEvent: ({ data }) => {
        events.push(data);
        abort.abort();
      },
    });
    expect(events).toEqual(["first"]);
  });
  it("surfaces HTTP errors to one-shot readers", async () => {
    const url = await server((_, res) => {
      res.writeHead(401);
      res.end("denied");
    });
    await expect(
      readSse(url, { signal: controller().signal, reconnect: false, onEvent: () => {} }),
    ).rejects.toThrow("SSE HTTP status 401");
  });
  it("stops reconnecting when the server returns HTTP 204", async () => {
    const url = await server((_, res) => {
      res.writeHead(204);
      res.end();
    });
    const reconnects: unknown[] = [];
    await readSse(url, {
      signal: controller().signal,
      onEvent: () => {
        throw new Error("unexpected event");
      },
      onReconnect: (info) => reconnects.push(info),
    });
    expect(reconnects).toEqual([]);
  });
});
