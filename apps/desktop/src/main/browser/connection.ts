import { z } from "zod";
import type { BrowserBackend } from "./backend.ts";
import { BrowserBackendServerMessage, type DeviceCredential } from "@ace/protocol";

/**
 * - `off`: no window to draw views in, so this app is not offering a backend;
 * - `connecting`: hello and registration in progress;
 * - `registered`: the daemon routes embedded browser sessions here;
 * - `unsupported`: the daemon publishes no desktop credential or does not know the frames;
 * - `rejected`: the daemon refused the credential or already has a desktop backend;
 * - `offline`: no daemon to reach right now.
 */
export type BackendState =
  | "off"
  | "connecting"
  | "registered"
  | "unsupported"
  | "rejected"
  | "offline";

export interface ConnectionPorts {
  /** The local daemon's address and host token; undefined when there is none. */
  daemon(): Promise<{ url: string; token: string } | undefined>;
  /** The daemon's `browser-desktop.json`, or undefined when it publishes none. */
  credential(): Promise<DeviceCredential | undefined>;
  socket(url: string): WebSocket;
  timers: { set(delayMs: number, callback: () => void): () => void };
  id(): string;
  log(message: string): void;
}

export interface ConnectionOptions {
  /** Keeps the socket inside the daemon's idle timeout. */
  pingMs?: number;
  handshakeMs?: number;
  maxRetryMs?: number;
  /** Bytes the socket may buffer before a reliable send counts as refused. */
  bufferLimit?: number;
}

const Reply = z.object({
  type: z.string(),
  code: z.string().optional(),
  message: z.string().optional(),
  ok: z.boolean().optional(),
});
const capabilities = {
  cdp: true,
  targets: true,
  permissions: true,
  downloads: true,
  controllerLease: true,
} as const;

/**
 * The embedded browser backend's own daemon socket (ADR 0055). It is separate from the
 * notification link on purpose: an older daemon that rejects `browser.backend.*` frames, a
 * refused credential or a slow relay can only ever close this socket, never the link that
 * carries notifications, the badge and the tray.
 *
 * It authenticates with the host token and the desktop credential's device id, registers
 * with the credential, then hands requests to the backend. Lost connections retry with
 * backoff while a window exists; without one it unregisters, so the daemon pauses or moves
 * those sessions and runs new ones headless.
 */
export class BackendConnection {
  private backend: BrowserBackend;
  private ports: ConnectionPorts;
  private options: Required<ConnectionOptions>;
  private wanted = false;
  private generation = 0;
  private socket: WebSocket | undefined;
  private registered: WebSocket | undefined;
  private attempt = 0;
  private cancelRetry: (() => void) | undefined;
  private current: BackendState = "off";
  private listeners = new Set<(state: BackendState) => void>();

  constructor(backend: BrowserBackend, ports: ConnectionPorts, options: ConnectionOptions = {}) {
    this.backend = backend;
    this.ports = ports;
    this.options = {
      pingMs: options.pingMs ?? 20_000,
      handshakeMs: options.handshakeMs ?? 10_000,
      maxRetryMs: options.maxRetryMs ?? 60_000,
      bufferLimit: options.bufferLimit ?? 8 * 1024 * 1024,
    };
  }

  state(): BackendState {
    return this.current;
  }
  onState(listener: (state: BackendState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Offer the backend while the app has a window to draw views in. */
  setAvailable(available: boolean): void {
    if (available === this.wanted) return;
    this.wanted = available;
    if (available) void this.connect();
    else this.disconnect();
  }

  /** The daemon (re)started or the machine woke: try again now. */
  wake(): void {
    if (!this.wanted || this.socket) return;
    this.attempt = 0;
    void this.connect();
  }

  /** The person asked for control of a thread's view from this app. */
  takeover(threadId: string): void {
    this.sendBrowser("browser.takeover", threadId);
  }
  handback(threadId: string): void {
    this.sendBrowser("browser.handback", threadId);
  }

  close(): void {
    this.wanted = false;
    this.disconnect();
  }

  private async connect(): Promise<void> {
    if (!this.wanted || this.socket) return;
    const generation = ++this.generation;
    this.clearRetry();
    this.setState("connecting");
    const credential = await this.ports.credential().catch(() => undefined);
    if (generation !== this.generation || !this.wanted) return;
    if (!credential) return this.retry("unsupported");
    const daemon = await this.ports.daemon().catch(() => undefined);
    if (generation !== this.generation || !this.wanted) return;
    if (!daemon) return this.retry("offline");
    this.open(daemon, credential);
  }

  private open(daemon: { url: string; token: string }, credential: DeviceCredential): void {
    const socket = this.ports.socket(daemon.url);
    this.socket = socket;
    const requestId = this.ports.id();
    let outcome: BackendState = "offline";
    let stopPing: (() => void) | undefined;
    const stopHandshake = this.ports.timers.set(this.options.handshakeMs, () => {
      this.ports.log("The daemon did not accept the browser backend in time");
      socket.close();
    });
    const write = (serialized: string): boolean => {
      if (
        socket.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount > this.options.bufferLimit
      ) {
        // ADR 0055: a refused reliable message loses the backend; nothing is queued.
        socket.close();
        return false;
      }
      socket.send(serialized);
      return true;
    };
    const ping = () => {
      stopPing = this.ports.timers.set(this.options.pingMs, () => {
        if (write('{"type":"ping"}')) ping();
      });
    };
    socket.addEventListener("open", () => {
      write(
        JSON.stringify({
          type: "hello",
          protocolVersion: 1,
          deviceId: credential.device.id,
          token: daemon.token,
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const raw = parseJson(event.data);
      if (this.registered === socket) {
        const message = BrowserBackendServerMessage.safeParse(raw);
        if (message.success) return this.backend.handle(message.data);
        const reply = Reply.safeParse(raw);
        if (reply.success && (reply.data.type === "error" || reply.data.ok === false))
          this.ports.log(`Browser backend: ${reply.data.message ?? reply.data.code ?? "refused"}`);
        return;
      }
      const reply = Reply.safeParse(raw);
      if (!reply.success) return;
      if (reply.data.type === "welcome") {
        write(
          JSON.stringify({
            type: "browser.backend.register",
            requestId,
            credential: credential.token,
            version: 1,
            capabilities,
          }),
        );
        return;
      }
      if (reply.data.type === "error") {
        // An older daemon does not parse the frame at all; a newer one refuses the credential.
        outcome = reply.data.code === "invalid_message" ? "unsupported" : "rejected";
        this.ports.log(`The daemon refused the browser backend: ${reply.data.message ?? ""}`);
        socket.close();
        return;
      }
      const message = BrowserBackendServerMessage.safeParse(raw);
      if (
        message.success &&
        message.data.type === "browser.backend.registered" &&
        message.data.requestId === requestId
      ) {
        stopHandshake();
        this.registered = socket;
        this.attempt = 0;
        this.backend.attach({
          backendId: message.data.backendId,
          connectionId: message.data.connectionId,
          send: write,
        });
        this.setState("registered");
        ping();
      }
    });
    socket.addEventListener("close", () => {
      stopHandshake();
      stopPing?.();
      if (this.registered === socket) {
        this.registered = undefined;
        this.backend.detach();
      }
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.wanted) return;
      // A daemon without the frames stays that way until it restarts (`wake`); retrying
      // sooner would only make it log the same protocol error again.
      if (outcome === "unsupported") this.setState(outcome);
      else this.retry(outcome);
    });
  }

  private disconnect(): void {
    this.generation++;
    this.clearRetry();
    const socket = this.socket;
    this.socket = undefined;
    if (this.registered) {
      this.registered = undefined;
      // Close the views now; the socket's close event may arrive later.
      this.backend.detach();
    }
    socket?.close();
    this.setState("off");
  }

  private retry(state: BackendState): void {
    this.setState(state);
    this.clearRetry();
    const delay = Math.min(this.options.maxRetryMs, 1_000 * 2 ** this.attempt++);
    this.cancelRetry = this.ports.timers.set(delay, () => {
      this.cancelRetry = undefined;
      void this.connect();
    });
  }

  private clearRetry(): void {
    this.cancelRetry?.();
    this.cancelRetry = undefined;
  }

  private sendBrowser(type: "browser.takeover" | "browser.handback", threadId: string): void {
    const socket = this.registered;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type, requestId: this.ports.id(), threadId }));
  }

  private setState(state: BackendState): void {
    if (state === this.current) return;
    this.current = state;
    for (const listener of this.listeners) listener(state);
  }
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}
