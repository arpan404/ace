import type { ServerMessage } from "@ace/protocol";
import type { Credential } from "./credentials.ts";
import { ClientError, type Scheduler, type Transport } from "./types.ts";

/** How to reach a machine over one path: its transport and the credential its hello carries. */
export interface PathRoute {
  transport(): Transport;
  credential(): Promise<Credential>;
}

/** A frame a welcomed side path received, held until the connection takes the path. */
export type PathFrame = string | Uint8Array;
export interface PathEvents {
  frame(frame: PathFrame): void;
  close(code: number, reason: string): void;
}

/**
 * A second path to the machine, opened beside the active one and welcomed by the same daemon.
 * Nothing it receives reaches the client until the connection `take`s it; until then it can be
 * dropped with `close` and nothing else changes.
 */
export interface WelcomedPath {
  readonly transport: Transport;
  readonly welcome: Extract<ServerMessage, { type: "welcome" }>;
  /** Deliver held frames, then every later one, to `events`. */
  take(events: PathEvents): void;
  /** Frames heard before it was taken: a standby's pong proves it alive. */
  readonly heard: number;
  /** Send raw text on the path before it is taken (the standby's ping). */
  send(text: string): void;
  close(): void;
  /** Called once if the path closes before it is taken. */
  onClosed(listener: (code: number, reason: string) => void): void;
}

export interface HandshakeOptions {
  route: PathRoute;
  /** The hello this path sends, with this path's own credential and transport features. */
  hello(transport: Transport, credential: Credential): string;
  /** The welcome (or `starting`) a frame decodes to; anything else before welcome fails. */
  decode(text: string): ServerMessage | undefined;
  /** The daemon this connection already speaks to: a path to any other daemon is refused. */
  hostId: string;
  scheduler: Scheduler;
  timeoutMs: number;
}

/**
 * Open `route` beside the active path and say hello with the same credential the device holds
 * (ADR 0114). Resolves once the same daemon welcomes it; rejects (closing it) on any failure,
 * a mismatched daemon identity included. The active path is never touched.
 */
export function handshakePath(options: HandshakeOptions): Promise<WelcomedPath> {
  return new Promise((resolve, reject) => {
    let transport: Transport;
    try {
      transport = options.route.transport();
    } catch {
      reject(new ClientError("offline", "Path failed to open"));
      return;
    }
    let settled = false;
    let taken: PathEvents | undefined;
    let closedListener: ((code: number, reason: string) => void) | undefined;
    let closed: [number, string] | undefined;
    const held: PathFrame[] = [];
    let welcomed: WelcomedPath | undefined;
    let heard = 0;
    const fail = (error: ClientError) => {
      if (settled) return;
      settled = true;
      cancel();
      try {
        transport.close();
      } catch {
        /* Already gone. */
      }
      reject(error);
    };
    const cancel = options.scheduler.set(options.timeoutMs, () =>
      fail(new ClientError("offline", "Path handshake timed out")),
    );
    const frame = (value: PathFrame) => {
      if (closed) return;
      if (welcomed) {
        if (taken) {
          taken.frame(value);
          return;
        }
        heard++;
        // An idle standby holds nothing but its pongs, which only prove it alive.
        if (typeof value === "string" && value.startsWith('{"type":"pong"')) return;
        // No view subscribes on a path before it is taken, so what it hears is only pushes
        // the active path also carries: keep the newest few, never an unbounded backlog.
        if (held.push(value) > 64) held.shift();
        return;
      }
      if (typeof value !== "string") {
        fail(new ClientError("protocol", "Binary frame before welcome"));
        return;
      }
      let message: ServerMessage | undefined;
      try {
        message = options.decode(value);
      } catch {
        fail(new ClientError("protocol", "Unreadable frame before welcome"));
        return;
      }
      if (message?.type === "starting") return;
      if (message?.type !== "welcome") {
        fail(new ClientError("auth", "Path refused the hello"));
        return;
      }
      // Each path must prove the same machine; a different daemon is dropped, never used.
      if (message.hostId !== options.hostId) {
        fail(new ClientError("identity", "Path reached another machine"));
        return;
      }
      settled = true;
      cancel();
      welcomed = {
        transport,
        welcome: message,
        get heard() {
          return heard;
        },
        take(events) {
          taken = events;
          for (const kept of held.splice(0)) events.frame(kept);
          if (closed) events.close(...closed);
        },
        send: (text) => transport.send(text),
        close() {
          closed ??= [1000, "Path closed"];
          try {
            transport.close();
          } catch {
            /* Already gone. */
          }
        },
        onClosed(listener) {
          closedListener = listener;
        },
      };
      resolve(welcomed);
    };
    transport.open({
      open: () => {
        void options.route
          .credential()
          .then((credential) => {
            if (!settled) transport.send(options.hello(transport, credential));
          })
          .catch(() => fail(new ClientError("auth", "Path credential unavailable")));
      },
      message: frame,
      binary: frame,
      close: (code, reason) => {
        if (!welcomed) {
          fail(
            new ClientError(
              code === 4011 ? "machine_code" : code === 4001 || code === 4003 ? "auth" : "offline",
              reason ?? "Path closed",
            ),
          );
          return;
        }
        if (closed) return;
        closed = [code, reason ?? ""];
        if (taken) taken.close(code, reason ?? "");
        else closedListener?.(code, reason ?? "");
      },
    });
  });
}
