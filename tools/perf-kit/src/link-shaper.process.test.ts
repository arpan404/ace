import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";
import { expect, test } from "vitest";
import { linkProfiles, roundTrips, startLinkShaper } from "@ace/perf-kit/link";

/*
 * The proxy's wiring over real sockets: bytes cross unchanged in both directions, the profile's
 * round trip is paid per exchange, and the counts match what crossed. The arithmetic itself is
 * covered at unit level (link-pipe.test.ts).
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
