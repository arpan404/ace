import {
  Agent,
  createServer,
  request as httpRequest,
  type ClientRequestArgs,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { PassThrough, type Duplex } from "node:stream";
import {
  connectTarget,
  forwardHeaders,
  forwardTarget,
  proxyAuthorizes,
  proxyChallenge,
} from "./proxy-request.ts";
import type { MachineTunnel, TunnelStream } from "./tunnel-contract.ts";
import { failureStatus, tunnelFailure, type TunnelFailures } from "./tunnel-failure.ts";
import { pipeTunnel } from "./tunnel-pipe.ts";
import { TunnelSocket } from "./tunnel-socket.ts";

export interface MachineProxyOptions {
  /** The machine's tunnel now; undefined while this app can't reach the machine. */
  tunnel(): MachineTunnel | undefined;
  failures: TunnelFailures;
  log(message: string): void;
  /**
   * The password of this run's proxy: only the machine's partition is given it, through
   * Electron's `login` (`proxyLogin`). A request without it is refused.
   */
  secret: string;
  /** How long a stream may take to open on the machine before the browser is refused. */
  openMs?: number;
  /** How long a refused connection may stay open after its answer, read or not. */
  lingerMs?: number;
  /** How long a browser connection may take to send a request's headers. */
  headersMs?: number;
  /** Browser connections open at once; more are dropped. */
  maxConnections?: number;
}

/** Streams the plain-HTTP side keeps per port, busy or idle, as a browser would. */
const keptPerPort = 32;
/**
 * How long an idle plain-HTTP stream is kept for the next request: below the 5 s Node and Vite
 * keep their own idle connections, so the proxy never sends on one the dev server is closing.
 */
const keptIdleMs = 2_000;
const idempotent = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * One remote machine's localhost proxy (ADR 0194), an HTTP proxy on this computer's
 * `127.0.0.1` at a port the OS picks. Its partition's loopback arrives here: HTTPS and every
 * websocket as a CONNECT, whose bytes are then piped untouched through a tunnel stream, and
 * plain HTTP as absolute-form requests, sent on over kept streams to the same port. Every request
 * must carry the run's secret (`Proxy-Authorization`), which only the partition's browser knows,
 * so no other process on this computer can borrow the device's access to the machine. A target
 * that isn't the machine's loopback is refused. The device names a port, never a host.
 */
export class MachineProxy {
  readonly port: number;
  #server: Server;
  #agent: Agent;
  #sockets: Set<Duplex>;

  private constructor(server: Server, agent: Agent, sockets: Set<Duplex>, port: number) {
    this.#server = server;
    this.#agent = agent;
    this.#sockets = sockets;
    this.port = port;
  }

  static async listen(options: MachineProxyOptions): Promise<MachineProxy> {
    const sockets = new Set<Duplex>();
    const agent = new TunnelAgent((port) => openStream(options, port));
    const server = createServer({
      // A request's body may take as long as it takes (an upload); its headers may not.
      requestTimeout: 0,
      headersTimeout: options.headersMs ?? 10_000,
      keepAliveTimeout: 30_000,
    });
    server.maxConnections = options.maxConnections ?? 512;
    server.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    });
    server.on("request", (request: IncomingMessage, response: ServerResponse) =>
      forward(request, response, agent, options),
    );
    server.on("connect", (request: IncomingMessage, socket: Duplex, head: Buffer) =>
      tunnelConnect(request, socket, head, options),
    );
    // Chromium sends every websocket as a CONNECT; an upgrade in absolute form is not one of
    // its requests.
    server.on("upgrade", (_request: IncomingMessage, socket: Duplex) =>
      refuse(socket, 501, options),
    );
    server.on("clientError", (_error, socket: Duplex) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The proxy has no port");
    return new MachineProxy(server, agent, sockets, address.port);
  }

  /** Stops listening and resets every connection still open, kept streams included. */
  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.#server.close(() => resolve()));
    for (const socket of this.#sockets) socket.destroy();
    this.#agent.destroy();
    await closed;
  }
}

/** Kept plain-HTTP connections to the machine's ports, each one a tunnel stream. */
class TunnelAgent extends Agent {
  #open: (port: number) => Promise<TunnelStream>;

  constructor(open: (port: number) => Promise<TunnelStream>) {
    super({ keepAlive: true, maxSockets: keptPerPort, maxFreeSockets: 8, timeout: keptIdleMs });
    this.#open = open;
  }

  // Asynchronous, as the agent allows: the callback gets the stream once it opens, or the
  // open's error, which the request then fails with (the agent reads no stream beside one).
  override createConnection(
    options: ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): undefined {
    this.#open(Number(options.port)).then(
      (stream) => callback?.(null, new TunnelSocket(stream)),
      (error: unknown) =>
        callback?.(error instanceof Error ? error : new Error(String(error)), closedStream()),
    );
    return undefined;
  }
}

/** A stream that carries nothing, for the agent's callback beside an error. */
const closedStream = () => new PassThrough().destroy();

/** A stream to the machine's `port`, given up when `openMs` passes or `signal` aborts. */
async function openStream(
  options: MachineProxyOptions,
  port: number,
  signal?: AbortSignal,
): Promise<TunnelStream> {
  const { failures } = options;
  const tunnel = options.tunnel();
  if (!tunnel) {
    failures.record(port, "offline");
    throw Object.assign(new Error("offline"), { code: "offline" });
  }
  const controller = new AbortController();
  const late = setTimeout(() => controller.abort(), options.openMs ?? 10_000);
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    return await tunnel.open(port, { signal: controller.signal });
  } catch (error) {
    // An open the browser gave up on explains nothing; one past its deadline does.
    if (!signal?.aborted) {
      const failure = tunnelFailure(error);
      failures.record(port, failure);
      if (failure === "failed")
        options.log(
          `machine localhost: port ${port}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    throw error;
  } finally {
    clearTimeout(late);
    signal?.removeEventListener("abort", stop);
  }
}

/**
 * Answers a connection that won't be carried, then closes it within `lingerMs` whether or not
 * the browser reads the answer or closes its side, so a refused peer never holds a slot.
 */
function refuse(
  socket: Duplex,
  status: number,
  options: MachineProxyOptions,
  extra: readonly string[] = [],
): void {
  if (socket.destroyed) return;
  const hard = setTimeout(() => socket.destroy(), options.lingerMs ?? 2_000);
  socket.once("close", () => clearTimeout(hard));
  socket.end(
    [`HTTP/1.1 ${status} ${status === 407 ? "Proxy Authentication Required" : "Refused"}`]
      .concat(extra, ["Content-Length: 0", "Connection: close", "", ""])
      .join("\r\n"),
  );
}

/** HTTPS and websockets: once the stream opens, the connection's bytes go through untouched. */
function tunnelConnect(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: MachineProxyOptions,
): void {
  socket.on("error", () => {});
  if (!proxyAuthorizes(request.headers["proxy-authorization"], options.secret))
    return refuse(socket, 407, options, [`Proxy-Authenticate: ${proxyChallenge}`]);
  const target = connectTarget(request.url ?? "");
  if (!target) return refuse(socket, 403, options);
  const { port } = target;
  // The socket keeps being read while the stream opens, so a browser that gives up (closes or
  // ends its side) is seen, and its open given up with it. Chromium sends nothing more before
  // the answer; a caller that does, past a bound, is not a browser.
  const gone = new AbortController();
  const early: Buffer[] = head.byteLength ? [head] : [];
  let earlyBytes = head.byteLength;
  const leave = () => gone.abort();
  const hold = (chunk: Buffer) => {
    early.push(chunk);
    earlyBytes += chunk.byteLength;
    if (earlyBytes > earlyLimit) socket.destroy();
  };
  socket.on("data", hold);
  socket.once("end", leave);
  socket.once("close", leave);
  openStream(options, port, gone.signal).then(
    (stream) => {
      socket.off("data", hold);
      socket.off("end", leave);
      if (socket.destroyed || gone.signal.aborted) {
        stream.reset();
        if (!socket.destroyed) socket.destroy();
        return;
      }
      socket.pause();
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      pipeTunnel(socket, stream, {
        first: early.length ? new Uint8Array(Buffer.concat(early)) : undefined,
        onServed: () => options.failures.clear(port),
        onRefused: () => options.failures.record(port, "closed"),
      });
      socket.resume();
    },
    (error: unknown) => {
      socket.off("data", hold);
      socket.off("end", leave);
      if (!socket.destroyed) refuse(socket, failureStatus(tunnelFailure(error)), options);
    },
  );
}

/** Bytes a CONNECT may send before its stream is open. */
const earlyLimit = 64 * 1024;

/**
 * Plain HTTP: the request goes on in origin form over a kept stream to the machine's port, and
 * the response comes back as it arrives. A request that couldn't reach the machine drops the
 * browser's connection (Chromium's own error page, explained by the port's recorded failure);
 * one a dev server's idle close cut is sent once more when it carried no body.
 */
function forward(
  request: IncomingMessage,
  response: ServerResponse,
  agent: Agent,
  options: MachineProxyOptions,
): void {
  if (!proxyAuthorizes(request.headers["proxy-authorization"], options.secret)) {
    response.writeHead(407, { "Proxy-Authenticate": proxyChallenge, "Content-Length": 0 });
    response.end();
    return;
  }
  const target = forwardTarget(request.url ?? "");
  if (!target) {
    response.writeHead(403, { "Content-Length": 0, Connection: "close" });
    response.end();
    return;
  }
  const method = request.method ?? "GET";
  const bodiless =
    request.headers["transfer-encoding"] === undefined &&
    (request.headers["content-length"] ?? "0") === "0";
  const headers = forwardHeaders(request.rawHeaders);
  const send = (again: boolean) => {
    const upstream = httpRequest({
      agent,
      host: "127.0.0.1",
      port: target.port,
      method,
      path: target.path,
      headers,
      setHost: false,
    });
    let answered = false;
    response.once("close", () => {
      if (!response.writableFinished) upstream.destroy();
    });
    upstream.on("response", (incoming) => {
      answered = true;
      response.writeHead(
        incoming.statusCode ?? 502,
        incoming.statusMessage,
        forwardHeaders(incoming.rawHeaders),
      );
      incoming.pipe(response);
      incoming.on("error", () => response.destroy());
      incoming.on("aborted", () => response.destroy());
    });
    upstream.on("error", () => {
      if (!answered && !again && upstream.reusedSocket && bodiless && idempotent.has(method))
        return send(true);
      response.destroy();
      request.socket.destroy();
    });
    if (bodiless) upstream.end();
    else request.pipe(upstream);
  };
  send(false);
}
