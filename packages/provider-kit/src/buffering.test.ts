import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { probeOutput, spawnSupervised } from "./process.ts";
import { readSse } from "./sse.ts";
import { cleanupServers, controller, server } from "./testing/http.ts";

afterEach(cleanupServers);

it.each(["stdout", "stderr"])(
  "probe bounds unterminated %s before the child exits",
  async (pipe) => {
    await expect(
      probeOutput(
        process.execPath,
        ["-e", `process.${pipe}.write('x'.repeat(4096));setInterval(()=>{},1000);`],
        {
          maxBytes: 1024,
          timeoutMs: 5000,
        },
      ),
    ).rejects.toThrow("Probe output exceeded limit");
  },
  15000,
);

it("probe shares its raw byte budget across both output pipes", async () => {
  await expect(
    probeOutput(
      process.execPath,
      [
        "-e",
        "process.stdout.write('x'.repeat(768));process.stderr.write('y'.repeat(768));setInterval(()=>{},1000);",
      ],
      {
        maxBytes: 1024,
        timeoutMs: 5000,
      },
    ),
  ).rejects.toThrow("Probe output exceeded limit");
}, 15000);

it.each(["stdout", "stderr"])(
  "supervision stops an oversized unterminated %s line",
  async (pipe) => {
    const proc = spawnSupervised({
      command: process.execPath,
      args: ["-e", `process.${pipe}.write('é'.repeat(33));setInterval(()=>{},1000);`],
      env: {},
      name: "line-budget",
      maxLineBytes: 64,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exit = await Promise.race([
        proc.exited,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 3000);
        }),
      ]);
      expect(exit).toBeDefined();
      expect(String(proc.signal.reason)).toContain("Process output line exceeded limit");
    } finally {
      clearTimeout(timer);
      await proc.stop({ graceMs: 0 });
    }
  },
);

it("SSE rejects a fragmented oversized line and closes the live response", async () => {
  let disconnected = Promise.resolve<unknown>(undefined);
  let nextChunk: (() => void) | undefined;
  const url = await server((_, res) => {
    nextChunk = () => res.end("ééé");
    disconnected = once(res, "close");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: éééé\n\n");
    res.write("data: éé");
  });
  const events: string[] = [];
  await expect(
    readSse(url, {
      signal: controller().signal,
      maxLineBytes: 14,
      onEvent: (event) => {
        events.push(event.data);
        nextChunk?.();
      },
      reconnect: false,
    }),
  ).rejects.toThrow("SSE line exceeded limit");
  await disconnected;
  expect(events).toEqual(["éééé"]);
});

it("SSE rejects many small data lines before dispatch without reconnecting", async () => {
  const url = await server((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: éé\ndata: éé\ndata: éé\n\n");
  });
  const events: string[] = [],
    reconnects: unknown[] = [];
  await expect(
    readSse(url, {
      signal: controller().signal,
      maxEventBytes: 12,
      onEvent: (event) => events.push(event.data),
      onReconnect: (info) => {
        reconnects.push(info);
        throw new Error("unexpected reconnect");
      },
    }),
  ).rejects.toThrow("SSE event exceeded limit");
  expect(events).toEqual([]);
  expect(reconnects).toEqual([]);
});

it("raw probe budgets accept exact UTF-8 byte boundaries without a trailing newline", async () => {
  expect(
    await probeOutput(
      process.execPath,
      ["-e", "process.stdout.write('éé');process.stderr.write('é');"],
      { maxBytes: 6 },
    ),
  ).toEqual({ stdout: "éé", stderr: "é", code: 0 });
});

it("SSE resets byte budgets after each dispatched event", async () => {
  const url = await server((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: éé\n\ndata: éé\n\n");
  });
  const events: string[] = [];
  await readSse(url, {
    signal: controller().signal,
    reconnect: false,
    maxLineBytes: 10,
    maxEventBytes: 4,
    onEvent: (event) => events.push(event.data),
  });
  expect(events).toEqual(["éé", "éé"]);
});
