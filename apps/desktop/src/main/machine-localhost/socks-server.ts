import { createServer, type Server, type Socket } from "node:net";
import { isMachineLoopbackHost } from "./loopback.ts";
import {
  connectReply,
  greetingReply,
  parseConnect,
  parseGreeting,
  socksReply,
  type SocksReplyCode,
} from "./socks5.ts";
import type { MachineTunnel } from "./tunnel-contract.ts";
import { failureReply, tunnelFailure, type TunnelFailures } from "./tunnel-failure.ts";
import { pipeTunnel } from "./tunnel-pipe.ts";

export interface MachineProxyOptions {
  /** The machine's tunnel now; undefined while this app can't reach the machine. */
  tunnel(): MachineTunnel | undefined;
  failures: TunnelFailures;
  log(message: string): void;
  /** How long a browser connection may take to send its CONNECT. */
  handshakeMs?: number;
  /** Browser connections open at once; more are refused. */
  maxConnections?: number;
}

/** Bytes a browser may send before its CONNECT is complete; more is not SOCKS5. */
const handshakeLimit = 1024;

/**
 * One remote machine's SOCKS5 proxy, on this computer's `127.0.0.1` at a port the OS picks: its
 * partition's loopback arrives here (ADR 0194). CONNECT only, no authentication. A target that
 * isn't the machine's loopback is refused; any other goes to `MachineTunnel.open(port)` and its
 * bytes are piped both ways. The device names a port, never a host: the machine connects to its
 * own loopback.
 */
export class MachineProxy {
  readonly port: number;
  private server: Server;
  private sockets = new Set<Socket>();

  private constructor(server: Server, port: number) {
    this.server = server;
    this.port = port;
  }

  static async listen(options: MachineProxyOptions): Promise<MachineProxy> {
    const sockets = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: false }, (socket) => {
      if (sockets.size >= (options.maxConnections ?? 512)) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      handshake(socket, options);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The proxy has no port");
    const proxy = new MachineProxy(server, address.port);
    proxy.sockets = sockets;
    return proxy;
  }

  /** Stops listening and resets every connection still open. */
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** Reads the greeting and the CONNECT, then opens the tunnel stream and hands over. */
function handshake(socket: Socket, options: MachineProxyOptions): void {
  let buffer = new Uint8Array(0);
  let stage: "greeting" | "connect" | "opening" = "greeting";
  const timer = setTimeout(() => socket.destroy(), options.handshakeMs ?? 10_000);
  socket.on("close", () => clearTimeout(timer));
  const refuse = (code: SocksReplyCode) => {
    clearTimeout(timer);
    socket.end(connectReply(code));
  };
  const onData = (chunk: Buffer) => {
    const joined = new Uint8Array(buffer.length + chunk.length);
    joined.set(buffer);
    joined.set(chunk, buffer.length);
    buffer = joined;
    if (buffer.length > handshakeLimit) return void socket.destroy();
    if (stage === "greeting") {
      const greeting = parseGreeting(buffer);
      if (greeting.kind === "more") return;
      if (greeting.kind === "invalid") return void socket.destroy();
      socket.write(greetingReply(greeting.noAuth));
      if (!greeting.noAuth) return void socket.end();
      buffer = buffer.slice(greeting.length);
      stage = "connect";
    }
    if (stage !== "connect") return;
    const request = parseConnect(buffer);
    if (request.kind === "more") return;
    if (request.kind === "invalid") return refuse(request.reply ?? socksReply.generalFailure);
    stage = "opening";
    socket.off("data", onData);
    socket.pause();
    const first = buffer.slice(request.length);
    if (!isMachineLoopbackHost(request.host)) return refuse(socksReply.notAllowed);
    open(socket, request.port, first, options, timer);
  };
  socket.on("data", onData);
}

function open(
  socket: Socket,
  port: number,
  first: Uint8Array,
  options: MachineProxyOptions,
  timer: ReturnType<typeof setTimeout>,
): void {
  const { failures } = options;
  const fail = (failure: Parameters<typeof failureReply>[0]) => {
    clearTimeout(timer);
    failures.record(port, failure);
    if (!socket.destroyed) socket.end(connectReply(failureReply(failure)));
  };
  const tunnel = options.tunnel();
  if (!tunnel) return fail("offline");
  tunnel.open(port).then(
    (stream) => {
      clearTimeout(timer);
      if (socket.destroyed) {
        stream.reset();
        return;
      }
      socket.write(connectReply(socksReply.succeeded));
      pipeTunnel(socket, stream, {
        first,
        onServed: () => failures.clear(port),
        onRefused: () => failures.record(port, "closed"),
      });
      socket.resume();
    },
    (error: unknown) => {
      const failure = tunnelFailure(error);
      if (failure === "failed")
        options.log(
          `machine localhost: port ${port}: ${error instanceof Error ? error.message : String(error)}`,
        );
      fail(failure);
    },
  );
}
