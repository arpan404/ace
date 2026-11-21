import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";
import { expect, test } from "vitest";
import { linkProfiles, roundTrips, startLinkShaper } from "@ace/perf-kit/link";

/*
 * The proxy's wiring over real sockets: bytes cross unchanged in both directions, the profile's
 * round trip is paid per exchange, and the counts match what crossed. The arithmetic itself is
 * covered at unit level (link-bottleneck.test.ts).
 */
test("an exchange through the shaper arrives intact, a round trip late, and is counted", async () => {
  const echo = createServer((socket) => socket.on("data", (chunk) => socket.write(chunk)));
  echo.listen(0, "127.0.0.1");
  await once(echo, "listening");
  const address = echo.address();
  if (!address || typeof address === "string") throw new Error("No echo address");
  const profile = { ...linkProfiles.lan, name: "test", rttMs: 120 };
  const shaper = await startLinkShaper({
    target: { host: "127.0.0.1", port: address.port },
    profile,
  });
  let client: Socket | undefined;
  try {
    const started = performance.now();
    client = connect(shaper.port, shaper.host);
    await once(client, "connect");
    // Every byte value, so a proxy that re-encoded anything would be caught.
    const payload = Buffer.from(Array.from({ length: 256 * 16 }, (_, index) => index % 256));
    const received: Buffer[] = [];
    let length = 0;
    const done = Promise.withResolvers<void>();
    client.on("data", (chunk: Buffer) => {
      received.push(chunk);
      length += chunk.length;
      if (length >= payload.length) done.resolve();
    });
    client.write(payload);
    await done.promise;
    const elapsed = performance.now() - started;
    expect(Buffer.concat(received).equals(payload)).toBe(true);
    // Handshake round trip, then the request out and its echo back.
    expect(elapsed).toBeGreaterThanOrEqual(2 * profile.rttMs - 5);
    const counts = shaper.counts();
    expect(counts).toMatchObject({
      connections: 1,
      upBytes: payload.length,
      downBytes: payload.length,
      upFlights: 1,
    });
    expect(roundTrips(counts)).toBe(2);
  } finally {
    client?.destroy();
    await shaper.close();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  }
});

test("an answer the server sends just before closing still reaches the client", async () => {
  // HTTP without keep-alive does this: answer, then close at once. The answer is still crossing.
  const answer = Buffer.from("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
  const server = createServer((socket) => socket.once("data", () => socket.end(answer)));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  const profile = { ...linkProfiles.lan, name: "test", rttMs: 80 };
  const shaper = await startLinkShaper({
    target: { host: "127.0.0.1", port: address.port },
    profile,
  });
  const client = connect(shaper.port, shaper.host);
  try {
    await once(client, "connect");
    const received: Buffer[] = [];
    client.on("data", (chunk: Buffer) => received.push(chunk));
    client.write("GET / HTTP/1.1\r\n\r\n");
    await once(client, "end");
    expect(Buffer.concat(received).equals(answer)).toBe(true);
  } finally {
    client.destroy();
    await shaper.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** A listener on loopback; `serve` gets each accepted socket. */
async function listener(serve: (socket: Socket) => void, allowHalfOpen = false) {
  const server = createServer({ allowHalfOpen }, (socket) => {
    // Torn down by the proxy at the end of a test; the reset is expected.
    socket.on("error", () => undefined);
    serve(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Reads a connection to its end. */
async function readAll(socket: Socket): Promise<Buffer> {
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  await once(socket, "end");
  return Buffer.concat(chunks);
}

test("parallel connections through one shaper share its bandwidth", async () => {
  const size = 100_000;
  const server = await listener((socket) => socket.end(Buffer.alloc(size, 7)));
  // 4 Mbit/s down is 500 bytes per millisecond: one transfer takes 200 ms, four take 800 ms.
  const profile = { ...linkProfiles.lan, name: "test", downBitsPerSecond: 4_000_000 };
  const shaper = await startLinkShaper({
    target: { host: "127.0.0.1", port: server.port },
    profile,
  });
  try {
    const transfer = async () => readAll(connect(shaper.port, shaper.host));
    let started = performance.now();
    await transfer();
    const alone = performance.now() - started;
    started = performance.now();
    const results = await Promise.all([transfer(), transfer(), transfer(), transfer()]);
    const together = performance.now() - started;
    expect(results.every((bytes) => bytes.length === size)).toBe(true);
    expect(together).toBeGreaterThanOrEqual((4 * size) / 500 - 20);
    expect(together).toBeGreaterThan(3 * alone);
    expect(shaper.counts().downBytes).toBe(5 * size);
  } finally {
    await shaper.close();
    await server.close();
  }
});

test("a receiver that stops reading stalls the sender while the proxy holds a bounded amount", async () => {
  // More than both loopback legs' kernel buffers hold: Linux grows a sending socket's to
  // 4 MiB (tcp_wmem), so 8 MiB could all leave the sender with no backpressure at all.
  const total = 32 * 1024 * 1024;
  const sender = { stalled: false, sent: 0 };
  const server = await listener((socket) => {
    const chunk = Buffer.alloc(64 * 1024, 1);
    const pushMore = () => {
      while (sender.sent < total) {
        sender.sent += chunk.length;
        if (!socket.write(chunk)) {
          sender.stalled = true;
          socket.once("drain", pushMore);
          return;
        }
      }
      socket.end();
    };
    pushMore();
  });
  const profile = { ...linkProfiles.lan, name: "test" };
  const shaper = await startLinkShaper({
    target: { host: "127.0.0.1", port: server.port },
    profile,
  });
  const client = connect(shaper.port, shaper.host);
  try {
    await once(client, "connect");
    client.pause();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // The sender is waiting for room, well short of everything, and the proxy kept to its bound
    // plus the one socket read that crossed it (up to 64 KiB on Node, 512 KiB on Bun). Without
    // backpressure it would hold most of the 32 MiB.
    expect(sender.stalled).toBe(true);
    expect(sender.sent).toBeLessThan(total);
    expect(shaper.peakHeldBytes()).toBeLessThanOrEqual(profile.queueBytes + 512 * 1024);
    const delivered = shaper.counts().downBytes;
    expect(delivered).toBeLessThan(total);
    // Reading again, everything arrives, and only then is it all counted as delivered.
    const received = readAll(client);
    client.resume();
    expect((await received).length).toBe(total);
    expect(shaper.counts().downBytes).toBe(total);
  } finally {
    client.destroy();
    await shaper.close();
    await server.close();
  }
});

test("a client that sends a request and half-closes still gets the delayed answer", async () => {
  const answer = Buffer.from("the answer, sent after the request ended");
  const server = await listener((socket) => {
    socket.resume();
    socket.on("end", () => socket.end(answer));
  }, true);
  const profile = { ...linkProfiles.lan, name: "test", rttMs: 80 };
  const shaper = await startLinkShaper({
    target: { host: "127.0.0.1", port: server.port },
    profile,
  });
  const client = connect({ port: shaper.port, host: shaper.host, allowHalfOpen: true });
  try {
    await once(client, "connect");
    const received = readAll(client);
    client.end("GET /");
    expect((await received).equals(answer)).toBe(true);
  } finally {
    client.destroy();
    await shaper.close();
    await server.close();
  }
});
