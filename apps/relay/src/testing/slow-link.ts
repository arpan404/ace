import { createServer, connect, type Socket } from "node:net";

export interface LinkShape {
  /** Bottleneck rate each way, bytes per second. */
  bytesPerSecond: number;
  /** Round trip added by the link; each direction delays by half. */
  roundTripMs: number;
}

const SLICE = 4096;

/** About 3G: 400 kbit/s, 400 ms round trips. */
export const threeG: LinkShape = { bytesPerSecond: 400_000 / 8, roundTripMs: 400 };

/**
 * One direction of a shaped link: bytes leave no faster than the rate and arrive half a round
 * trip later. What the far end has not taken yet waits here, unbounded, as it would in a phone
 * network's queue or a relay that cannot pause a socket.
 */
function shape(from: Socket, to: Socket, link: LinkShape): void {
  // Slices in arrival order, each with when it reaches the far end. One timer drains them in
  // order: separate timers could swap two slices whose times round to the same millisecond.
  const queue: { at: number; slice: Buffer }[] = [];
  let freeAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  const drain = () => {
    timer = undefined;
    const now = performance.now();
    while (queue[0] && queue[0].at <= now) {
      const next = queue.shift();
      if (next && !to.destroyed) to.write(next.slice);
    }
    if (queue[0]) timer = setTimeout(drain, Math.max(1, queue[0].at - now));
    else if (closing) to.destroy();
  };
  from.on("data", (data: Buffer) => {
    const now = performance.now();
    // In slices, so bytes arrive as they cross the link rather than a whole read at once.
    for (let offset = 0; offset < data.length; offset += SLICE) {
      const slice = data.subarray(offset, offset + SLICE);
      freeAt = Math.max(freeAt, now) + (slice.length * 1000) / link.bytesPerSecond;
      queue.push({ at: freeAt + link.roundTripMs / 2, slice });
    }
    timer ??= setTimeout(drain, Math.max(1, (queue[0]?.at ?? now) - now));
  });
  from.on("close", () => {
    closing = true;
    timer ??= setTimeout(drain, link.roundTripMs / 2);
  });
  from.on("error", () => to.destroy());
}

/**
 * A TCP proxy in front of `target` (a relay's `ws://host:port` URL) that shapes every
 * connection like a slow link, for tests and benches. Returns its own URL.
 */
export async function slowLink(
  target: string,
  link: LinkShape,
): Promise<{ url: string; close(): Promise<void> }> {
  const { hostname, port } = new URL(target);
  const sockets = new Set<Socket>();
  const server = createServer((near) => {
    const far = connect(Number(port), hostname);
    for (const socket of [near, far]) {
      socket.setNoDelay(true);
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    }
    shape(near, far, link);
    shape(far, near, link);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
