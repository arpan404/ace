import { connect, type Socket } from "node:net";
import type { MachineTunnel, TunnelStream } from "./tunnel-contract.ts";

/**
 * A `MachineTunnel` to this computer's own loopback, for tests and for running the desktop app
 * against a dev server with no second machine (`ACE_DEV_LOOPBACK_TUNNEL=1`). It behaves as the
 * contract says: a refused port rejects with the code `refuse` names, and nothing listening
 * rejects with `tunnel_reset`.
 */
export function loopbackTunnel(
  options: { refuse?(port: number): string | undefined } = {},
): MachineTunnel {
  const open = new Set<Socket>();
  let closed = false;
  return {
    async open(port) {
      if (closed) throw coded("offline");
      const code = options.refuse?.(port);
      if (code) throw coded(code);
      const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
      open.add(socket);
      socket.on("close", () => open.delete(socket));
      // As the machine does: a port with nothing listening rejects before the stream opens.
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", () => reject(coded("tunnel_reset")));
      });
      return socketStream(socket);
    },
    ports: { get: () => [], subscribe: () => () => {} },
    close() {
      closed = true;
      for (const socket of open) socket.destroy();
    },
  };
}

const coded = (code: string) => Object.assign(new Error(code), { name: "ClientError", code });

function socketStream(socket: Socket): TunnelStream {
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  const readable = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let settled = false;
        const settle = (finish: () => void) => {
          if (settled) return;
          settled = true;
          try {
            finish();
          } catch {
            /* cancelled by the reader */
          }
        };
        socket.on("data", (chunk: Buffer) => {
          if (settled) return;
          controller.enqueue(new Uint8Array(chunk));
          if ((controller.desiredSize ?? 0) <= 0) socket.pause();
        });
        socket.on("end", () => settle(() => controller.close()));
        socket.on("error", (error) => settle(() => controller.error(error)));
        // Closed before its end arrived: a reset.
        socket.on("close", () => settle(() => controller.error(new Error("reset"))));
      },
      pull() {
        socket.resume();
      },
      cancel() {
        socket.destroy();
      },
    },
    { highWaterMark: 256 * 1024, size: (chunk) => chunk.byteLength },
  );
  return {
    readable,
    write: (chunk) =>
      new Promise((resolve, reject) =>
        socket.write(chunk, (error) => (error ? reject(error) : resolve())),
      ),
    end: () => socket.end(),
    reset: () => {
      if (typeof socket.resetAndDestroy === "function" && !socket.connecting)
        socket.resetAndDestroy();
      else socket.destroy();
    },
    closed,
  };
}
