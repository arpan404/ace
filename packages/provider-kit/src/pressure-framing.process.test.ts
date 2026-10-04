import { PassThrough } from "node:stream";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { lineReader } from "./line-reader.ts";
import { readSse } from "./sse.ts";
import { server, controller, cleanupServers } from "./testing/http.ts";
afterEach(cleanupServers);

// Mutation cases: LF-only framing; CR-only unbounded retention; feeding an entire SSE
// chunk after one event raises pressure. Not executed (tests run at merge).
test.each(["\n", "\r", "\r\n"])("a 64 KiB %j burst pauses between complete lines", async (ending) => {
  const input = new PassThrough();
  const blocked = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let paused = false;
  const failures: Error[] = [];
  const lines = lineReader(input, 65536, (error) => failures.push(error), {
    paused: () => paused,
    wait: () => { blocked.resolve(); return resume.promise; },
  });
  const received: string[] = [];
  lines.on("line", (line) => { received.push(line); paused = received.length === 1; });
  const closed = once(lines, "close");
  const records = Array.from({ length: 1024 }, (_, i) => String(i).padEnd(64 - ending.length, "x"));
  const burst = records.join(ending) + ending;
  expect(Buffer.byteLength(burst)).toBe(65536);
  input.end(burst);
  await blocked.promise;
  expect(received).toEqual([records[0]]);
  paused = false;
  resume.resolve();
  await closed;
  expect(received).toEqual(records);
  expect(failures).toEqual([]);
});

test("a CRLF split across reads terminates one line and preserves the next record", async () => {
  const input = new PassThrough();
  const lines = lineReader(input, 64, (error) => { throw error; });
  const first = Promise.withResolvers<void>();
  const received: string[] = [];
  lines.on("line", (line) => { received.push(line); first.resolve(); });
  const closed = once(lines, "close");
  input.write("first\r");
  await first.promise;
  input.end("\nsecond\r\nthird\n");
  await closed;
  expect(received).toEqual(["first", "second", "third"]);
});

test("CR-only SSE dispatch stops at pressure and resumes each event exactly once", async () => {
  const url = await server((_, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("data: first\r\rdata: second\r\rdata: third\r\r");
  });
  const blocked = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const events: string[] = [];
  let paused = false;
  const reading = readSse(url, {
    signal: controller().signal, reconnect: false,
    outputFlow: { paused: () => paused, wait: () => { blocked.resolve(); return resume.promise; } },
    onEvent: ({ data }) => { events.push(data); paused = events.length === 1; },
  });
  await blocked.promise;
  expect(events).toEqual(["first"]);
  paused = false;
  resume.resolve();
  await reading;
  expect(events).toEqual(["first", "second", "third"]);
});

// Mutation case: await the gate without racing cancellation. The gate is never released.
// Not executed (tests run at merge).
test("aborting SSE under pressure settles the reader and closes the real HTTP stream", async () => {
  const abort = controller();
  const closed = Promise.withResolvers<void>();
  const url = await server((_, response) => {
    response.once("close", closed.resolve);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: ready\n\ndata: held\n\n");
  });
  const blocked = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const events: string[] = [];
  const reading = readSse(url, {
    signal: abort.signal,
    outputFlow: { paused: () => events.length > 0, wait: () => { blocked.resolve(); return gate.promise; } },
    onEvent: ({ data }) => events.push(data),
  });
  await blocked.promise;
  abort.abort();
  await reading;
  await closed.promise;
  expect(events).toEqual(["ready"]);
});
