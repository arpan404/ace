import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { expect, it } from "vitest";
import { SocketInput } from "./socket-input.ts";
import { Client } from "./socket-test-support.ts";

it.each(["socket", "global"] as const)(
  "rejects excess %s input while a handler is pending and recovers after draining",
  async (limit) => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const input = new SocketInput();
    const clients: Client[] = [];
    const errors: unknown[] = [];
    let frames = 0,
      arrived: (() => void) | undefined;
    const count = limit === "socket" ? 9 : 19;
    const checkpoints = new Map<number, () => void>();
    const reached = (target: number) =>
      frames >= target
        ? Promise.resolve()
        : new Promise<void>((resolve) => checkpoints.set(target, resolve));
    const ready = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const open = async () => {
      const connected = once(server, "connection");
      const client = new Client(`ws://127.0.0.1:${address.port}`);
      clients.push(client);
      const opened = once(client.socket, "open");
      const [socket] = await connected;
      if (!(socket instanceof WebSocket)) throw new Error("Missing server socket");
      input.listen(
        socket,
        async () => {
          await gate;
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "pong" }));
        },
        (error) => errors.push(error),
      );
      socket.on("message", () => {
        frames++;
        checkpoints.get(frames)?.();
        if (frames === count) arrived?.();
      });
      await opened;
      return client;
    };
    try {
      const first = await open();
      const second = limit === "global" ? await open() : first;
      const victim = limit === "global" ? await open() : first;
      const closed = once(victim.socket, "close").then(([code]) => code);
      if (limit === "socket") {
        for (let i = 0; i < 9; i++) first.send({ type: "ping" });
      } else {
        for (let i = 0; i < 7; i++) first.socket.send(" ".repeat(900 * 1024));
        await reached(7);
        for (let i = 0; i < 7; i++) second.socket.send(" ".repeat(900 * 1024));
        await reached(14);
        for (let i = 0; i < 5; i++) victim.socket.send(" ".repeat(900 * 1024));
      }
      await ready;
      finish?.();
      expect(
        await Promise.race([
          closed,
          victim.next().then(
            () => "delivered",
            () => closed,
          ),
        ]),
      ).toBe(4009);
      if (limit === "global") {
        for (let i = 0; i < 7; i++) {
          expect(await first.next()).toEqual({ type: "pong" });
          expect(await second.next()).toEqual({ type: "pong" });
        }
        // Reuse a surviving socket too, exercising the per-socket frame accounting.
        first.send({ type: "ping" });
        first.send({ type: "ping" });
        expect(await first.next()).toEqual({ type: "pong" });
        expect(await first.next()).toEqual({ type: "pong" });
      }
      const recovered = await open();
      // More than the stale-accounting remainder (188,416 bytes): a tiny ping
      // would still fit if completed handlers never returned their bytes.
      recovered.socket.send(" ".repeat(900 * 1024));
      expect(await recovered.next()).toEqual({ type: "pong" });
      expect(errors).toEqual([]);
    } finally {
      finish?.();
      for (const client of clients) await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
