import type { TunnelLink, TunnelPath } from "@ace/client/machine-tunnel";
import { createMux, type PreviewSocket } from "@ace/preview/mux";

/*
 * A machine's tunnel end in memory (ADR 0194), for the bridge's tests and its throughput bench:
 * the real stream mux on both sides, with a dev server on every port that answers
 * `GET /bytes/<n>` with n bytes and closes. Nothing listens on `closedPort`.
 */

export const closedPort = 1;

type Schedule = (run: () => void, delayMs: number) => () => void;

/** How a served response is cut, as a socket reads it. */
const readSize = 64 * 1024;

/** One dev-server connection on the machine's loopback. */
function devServerSocket(port: number, later: (run: () => void) => void) {
  let data: ((bytes: Uint8Array) => void) | undefined;
  const ends: (() => void)[] = [];
  const closes: (() => void)[] = [];
  let connect: (() => void) | undefined;
  let paused = true;
  let request = "";
  let response: Uint8Array | undefined;
  let sent = 0;
  let destroyed = false;
  const flush = () => {
    if (destroyed || paused || !response || !data) return;
    // `data` may pause the socket (the mux waits for credit), which ends this loop.
    while (sent < response.byteLength) {
      if (paused) return;
      const piece = response.subarray(sent, sent + readSize);
      sent += piece.byteLength;
      data(piece);
    }
    if (sent >= response.byteLength) {
      response = undefined;
      for (const end of ends) end();
      later(() => {
        for (const close of closes) close();
      });
    }
  };
  const socket: PreviewSocket = {
    readableLength: 0,
    writableLength: 0,
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      later(flush);
    },
    destroy() {
      destroyed = true;
    },
    end() {},
    write(bytes, callback) {
      request += new TextDecoder().decode(bytes);
      const head = /^GET \/bytes\/(\d+)[ ?]/.exec(request);
      if (head && request.includes("\r\n\r\n") && !response) {
        const size = Number(head[1]);
        const header = new TextEncoder().encode(
          `HTTP/1.1 200 OK\r\nContent-Length: ${size}\r\nConnection: close\r\n\r\n`,
        );
        response = new Uint8Array(header.byteLength + size);
        response.set(header);
        response.fill(97, header.byteLength);
        later(flush);
      }
      callback();
    },
    on(event: "data" | "end" | "close" | "error", listener: (bytes: Uint8Array) => void) {
      const none = new Uint8Array(0);
      if (event === "data") data = listener;
      else if (event === "end") ends.push(() => listener(none));
      else if (event === "close") closes.push(() => listener(none));
    },
    once(_event: "connect", listener: () => void) {
      connect = listener;
    },
  };
  return {
    socket,
    connect: () => {
      // Nothing listens: the connection fails, as a refused connect closes the socket.
      if (port === closedPort)
        later(() => {
          for (const close of closes) close();
        });
      else later(() => connect?.());
    },
  };
}

/** A tunnel path to an in-memory machine that listens on `ports`. */
export function memoryMachine(options: { ports: number[]; schedule: Schedule }): TunnelPath {
  const later = (run: () => void) => {
    options.schedule(run, 0);
  };
  return {
    key: "memory",
    link(): TunnelLink {
      let toPhone: ((message: Uint8Array | { type: string; ports?: number[] }) => void) | undefined;
      let machineFrame: ((frame: Uint8Array) => void) | undefined;
      let ended: (() => void) | undefined;
      createMux({
        channel: {
          send: async (frame) => {
            const copy = frame.slice();
            later(() => toPhone?.(copy));
          },
          close: () => ended?.(),
          subscribe(onFrame) {
            machineFrame = onFrame;
            return () => {
              machineFrame = undefined;
            };
          },
        },
        maxStreams: 512,
        allowPort: async () => true,
        socketFactory: (port) => devServerSocket(port, later),
        timer: options.schedule,
      });
      return {
        open(events) {
          toPhone = (message) => void events.message(message as never);
          ended = () => events.close();
          later(() => {
            events.ready();
            toPhone?.({ type: "tunnel.ports", ports: options.ports });
          });
        },
        async sendBinary(bytes) {
          const copy = bytes.slice();
          later(() => machineFrame?.(copy));
        },
        close() {
          toPhone = undefined;
        },
      };
    },
  };
}
