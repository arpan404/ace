import { afterEach, describe, expect, it } from "vitest";
import { readSse } from "./sse.ts";
import { server, controller, cleanupServers } from "./testing/http.ts";
afterEach(cleanupServers);

describe("SSE recovery", () => {
  it("reports recurring heartbeat gaps until the caller aborts", async () => {
    const abort = controller();
    const url = await server((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: heartbeat\n\n");
    });
    const gaps: number[] = [];
    let heartbeatReceived = false;
    await readSse(url, {
      signal: abort.signal,
      onEvent: ({ data }) => {
        if (data === "heartbeat") heartbeatReceived = true;
      },
      heartbeat: {
        gapMs: 20,
        onGap: (elapsed) => {
          if (!heartbeatReceived) return;
          gaps.push(elapsed);
          if (gaps.length === 3) abort.abort();
        },
      },
    });
    expect(gaps).toHaveLength(3);
    expect(gaps[1]).toBeGreaterThan(gaps[0] ?? 0);
    expect(gaps[2]).toBeGreaterThan(gaps[1] ?? 0);
  });
  it("resets backoff after a recovered connection delivers an event", async () => {
    const abort = controller();
    let connection = 0;
    const url = await server((_, res) => {
      connection++;
      if (connection === 1 || connection === 2 || connection === 4) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${connection === 3 ? "recovered" : "finished"}\n\n`);
    });
    const delays: number[] = [];
    const events: string[] = [];
    await readSse(url, {
      signal: abort.signal,
      reconnect: { initialDelayMs: 2, maxDelayMs: 100 },
      onReconnect: (info) => delays.push(info.delayMs),
      onEvent: ({ data }) => {
        events.push(data);
        if (data === "finished") abort.abort();
      },
    });
    expect(events).toEqual(["recovered", "finished"]);
    expect(delays).toEqual([2, 4, 2, 4]);
  });
  it("rejects a successful HTTP response with the wrong content type", async () => {
    const url = await server((_, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("data: looks-valid\n\n");
    });
    const events: string[] = [];
    await expect(
      readSse(url, {
        signal: controller().signal,
        reconnect: false,
        onEvent: ({ data }) => events.push(data),
      }),
    ).rejects.toThrow("Expected text/event-stream response");
    expect(events).toEqual([]);
  });
  it("keeps the last event id across four connections and clears it on an empty id", async () => {
    const abort = controller();
    const headers: Array<string | string[] | undefined> = [];
    const url = await server((req, res) => {
      headers.push(req.headers["last-event-id"]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        headers.length === 1
          ? "id: persistent\ndata: first\n\n"
          : headers.length === 3
            ? "id:\ndata: cleared\n\n"
            : `data: ${headers.length}\n\n`,
      );
    });
    const events: string[] = [];
    const reconnects: number[] = [];
    await readSse(url, {
      signal: abort.signal,
      reconnect: { initialDelayMs: 1 },
      onReconnect: ({ attempt }) => reconnects.push(attempt),
      onEvent: ({ data }) => {
        events.push(data);
        if (data === "4") abort.abort();
      },
    });
    expect(reconnects).toEqual([1, 2, 3]);
    expect(headers).toEqual([undefined, "persistent", "persistent", undefined]);
    expect(events).toEqual(["first", "2", "cleared", "4"]);
  });
});
