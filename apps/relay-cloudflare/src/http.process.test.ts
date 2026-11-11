import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { hostId, keyPair } from "@ace/secure-channel";
import { connectHostToRelay } from "@ace/relay";
import type { RelayHttpHandler } from "@ace/relay";
import { deferred } from "@ace/relay/testing";
import { mint, startWorker } from "./testing/harness.ts";

// Public HTTP to a machine (ADR 0122) through the Worker and relay object under real workerd,
// served by a real daemon-side relay connection with an injected handler.

let worker: Awaited<ReturnType<typeof startWorker>>;
const cleanups: (() => unknown)[] = [];
beforeAll(async () => {
  worker = await startWorker();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
afterAll(() => worker.close());

async function daemon(
  handle: RelayHttpHandler | undefined,
  options: { enabled?: () => boolean } = {},
) {
  const hostKeys = keyPair();
  const connection = await connectHostToRelay({
    relayUrl: worker.relayUrl,
    hostKeys,
    account: { grant: async () => mint("machine", "user_a", hostId(hostKeys.publicKey)) },
    onClientChannel: (channel) => channel.close(),
    ...(handle ? { http: { enabled: options.enabled ?? (() => true), handle } } : {}),
  });
  cleanups.push(() => connection.close());
  return { id: connection.hostId, base: `${worker.http}/m/${connection.hostId}` };
}

/** An event stream the test feeds one event at a time, noting when the daemon cancels it. */
function eventStream() {
  const cancelled = deferred<void>();
  let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
    },
    cancel: () => cancelled.resolve(),
  });
  const response = new Response(body, { headers: { "content-type": "text/event-stream" } });
  const push = (text: string) => sink?.enqueue(new TextEncoder().encode(text));
  return { response, push, cancelled: cancelled.promise };
}

const pause = () => new Promise<false>((resolve) => setTimeout(() => resolve(false), 50));

/** Writes keepalives to each stream until one of them is cancelled by the daemon. */
async function keepWriting(...streams: ReturnType<typeof eventStream>[]): Promise<void> {
  const any = Promise.race(streams.map((stream) => stream.cancelled)).then(() => true);
  for (;;) {
    for (const stream of streams)
      try {
        stream.push(": keepalive\n\n");
      } catch {
        /* That one is closed. */
      }
    if (await Promise.race([any, pause()])) return;
  }
}

async function readText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value } = await reader.read();
  return new TextDecoder().decode(value);
}

it("a request reaches the daemon as its public URL and the response streams back as it is written", async () => {
  const seen = deferred<{
    url: string;
    method: string;
    body: string;
    headers: Headers;
    prefix: string;
  }>();
  const stream = eventStream();
  const machine = await daemon(async (request, _signal, forwarded) => {
    seen.resolve({
      url: request.url,
      method: request.method,
      body: await request.text(),
      headers: request.headers,
      prefix: forwarded.prefix,
    });
    return new Response(stream.response.body, {
      headers: { ...Object.fromEntries(stream.response.headers), "set-cookie": "s=1; Path=/" },
    });
  });

  const response = await fetch(`${machine.base}/mcp?x=1`, {
    method: "POST",
    headers: { authorization: "Bearer opaque", "content-type": "application/json" },
    body: '{"jsonrpc":"2.0"}',
  });
  const request = await seen.promise;
  expect(request).toMatchObject({
    url: `${machine.base}/mcp?x=1`,
    method: "POST",
    body: '{"jsonrpc":"2.0"}',
    prefix: `/m/${machine.id}`,
  });
  expect(request.headers.get("authorization")).toBe("Bearer opaque");
  expect(request.headers.get("cf-connecting-ip")).toBeNull();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");

  const reader = response.body!.getReader();
  stream.push("data: one\n\n");
  expect(await readText(reader)).toBe("data: one\n\n");
  stream.push("data: two\n\n");
  expect(await readText(reader)).toBe("data: two\n\n");
  await reader.cancel();
});

it("inserted metadata paths reach the machine at its own root form, and a large body arrives whole", async () => {
  const paths: string[] = [];
  const machine = await daemon(async (request) => {
    paths.push(new URL(request.url).pathname);
    const body = new Uint8Array(await request.arrayBuffer());
    return new Response(body.length ? body : "{}", {
      headers: { "content-type": "application/json" },
    });
  });
  const resource = await fetch(
    `${worker.http}/.well-known/oauth-protected-resource/m/${machine.id}/mcp`,
  );
  expect(resource.status).toBe(200);
  await resource.text();
  const server = await fetch(
    `${worker.http}/.well-known/oauth-authorization-server/m/${machine.id}`,
  );
  await server.text();
  expect(paths).toEqual([
    `/m/${machine.id}/.well-known/oauth-protected-resource/mcp`,
    `/m/${machine.id}/.well-known/oauth-authorization-server`,
  ]);

  // Over the response window, so the relay must credit the daemon as the caller reads.
  const big = new Uint8Array(900 * 1024).map((_, index) => index % 253);
  const echoed = await fetch(`${machine.base}/echo`, { method: "POST", body: big });
  expect(new Uint8Array(await echoed.arrayBuffer())).toEqual(big);
  const twice = new Uint8Array([...big, ...big].slice(0, 1024 * 1024));
  const again = await fetch(`${machine.base}/echo`, { method: "POST", body: twice });
  expect((await again.arrayBuffer()).byteLength).toBe(twice.length);

  const tooBig = await fetch(`${machine.base}/echo`, {
    method: "POST",
    body: new Uint8Array(1024 * 1024 + 1),
  });
  expect(tooBig.status).toBe(413);
});

it("a caller that leaves an event stream cancels the daemon's response and its request signal", async () => {
  const aborted = deferred<void>();
  const stream = eventStream();
  const machine = await daemon(async (_request, signal) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return stream.response;
  });
  const streaming = await fetch(`${machine.base}/listen`);
  const reader = streaming.body!.getReader();
  stream.push("data: hi\n\n");
  await readText(reader);
  await reader.cancel();
  // workerd notices a gone caller when the next bytes fail to send, as an SSE keepalive would.
  await keepWriting(stream);
  await aborted.promise;
});

it("an offline machine answers 503 to retry; one that doesn't serve HTTP, or has it off, answers 404", async () => {
  const offline = await fetch(`${worker.http}/m/${hostId(keyPair().publicKey)}/mcp`);
  expect(offline.status).toBe(503);
  expect(offline.headers.get("retry-after")).toBe("5");
  await offline.text();

  const older = await daemon(undefined);
  const unsupported = await fetch(`${older.base}/mcp`);
  expect(unsupported.status).toBe(404);

  const handled: string[] = [];
  const off = await daemon(
    async (request) => {
      handled.push(request.url);
      return new Response("served");
    },
    { enabled: () => false },
  );
  const refused = await fetch(`${off.base}/mcp`);
  expect(refused.status).toBe(404);
  expect(handled).toEqual([]);

  const malformed = await fetch(`${worker.http}/m/not-a-host/mcp`);
  expect(malformed.status).toBe(404);
});

it("requests keep working after the relay object hibernates between them", async () => {
  let served = 0;
  const machine = await daemon(async () => new Response(`served ${++served}`));
  expect(await (await fetch(`${machine.base}/mcp`)).text()).toBe("served 1");
  await worker.hibernate(machine.id);
  expect(await (await fetch(`${machine.base}/mcp`)).text()).toBe("served 2");
});

it("a machine holds at most four event streams open; the fifth is refused with 429", async () => {
  const streams: ReturnType<typeof eventStream>[] = [];
  const machine = await daemon(async () => {
    const stream = eventStream();
    streams.push(stream);
    return stream.response;
  });
  const open = await Promise.all(Array.from({ length: 4 }, () => fetch(`${machine.base}/listen`)));
  expect(open.map((response) => response.status)).toEqual([200, 200, 200, 200]);
  const fifth = await fetch(`${machine.base}/listen`);
  expect(fifth.status).toBe(429);
  await fifth.text();
  // The refused stream is cancelled on the daemon too.
  await streams[4]!.cancelled;
  await open[0]!.body!.cancel();
  // The daemon may have taken the four in any order; one of them is the cancelled one.
  await keepWriting(...streams.slice(0, 4));
  const again = await fetch(`${machine.base}/listen`);
  expect(again.status).toBe(200);
  for (const response of [...open.slice(1), again]) await response.body!.cancel();
});

// Last: it spends this address's budget for the rest of the minute.
it("callers over the per-address rate limit get 429", async () => {
  const target = `${worker.http}/m/${hostId(keyPair().publicKey)}/mcp`;
  const statuses: number[] = [];
  for (let batch = 0; batch < 7 && !statuses.includes(429); batch++)
    statuses.push(
      ...(await Promise.all(
        Array.from({ length: 50 }, async () => {
          const response = await fetch(target);
          await response.text();
          return response.status;
        }),
      )),
    );
  expect(statuses).toContain(429);
  expect(statuses.filter((status) => status !== 429).every((status) => status === 503)).toBe(true);
});
