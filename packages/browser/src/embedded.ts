import { EventEmitter } from "node:events";
import { z } from "zod";
import {
  BrowserBackendClientMessage,
  type BrowserBackendServerMessage,
  type BrowserBackendOperation,
  type BrowserBackendRequest,
} from "@ace/protocol";
import type { BrowserBackend, BackendOpen, BrowserBackendSession } from "./backend.ts";
import { installOriginGuard } from "./origin-guard.ts";
import { Screencast } from "./cdp.ts";
import { navigateCdp } from "./cdp-navigation.ts";
import type { NavigationClock } from "./navigation.ts";

const Navigation = z.object({
  frame: z.object({ url: z.string().max(8192), parentId: z.string().optional() }),
});
const Console = z.object({
  type: z.string(),
  args: z
    .array(z.object({ value: z.unknown().optional(), description: z.string().optional() }))
    .max(128),
});
const Response = z.object({
  response: z.object({ url: z.string().max(8192), status: z.number() }),
});
interface RemoteSession {
  events: EventEmitter;
  request: BackendOpen;
  url: string;
  pending: Set<string>;
  cleanup(): void;
}
interface Waiter {
  sessionId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cancel(): void;
}
export interface EmbeddedTransport {
  send(message: BrowserBackendServerMessage, serialized?: string): boolean;
  close(reason: string): void;
}
/** No send queue: reliable writes either enter the bounded socket or lose the backend. */
export class EmbeddedBackend implements BrowserBackend {
  readonly kind = "embedded";
  readonly id: string;
  private transport: EmbeddedTransport;
  private sessions = new Map<string, RemoteSession>();
  private pending = new Map<string, Waiter>();
  private sequence = 0;
  private closed = false;
  private lost: () => void;
  private clock: NavigationClock;
  constructor(
    id: string,
    transport: EmbeddedTransport,
    lost: () => void,
    clock: NavigationClock = {
      now: () => performance.now(),
      set: (delay, work) => {
        const timer = setTimeout(work, delay);
        timer.unref();
        return () => clearTimeout(timer);
      },
    },
  ) {
    this.id = id;
    this.transport = transport;
    this.lost = lost;
    this.clock = clock;
  }
  private send(message: BrowserBackendServerMessage): void {
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error("Browser relay payload limit");
    if (this.closed || !this.transport.send(message, serialized)) {
      this.disconnect("Desktop browser transport backpressure");
      throw new Error("Desktop browser backend lost");
    }
  }
  private call(
    sessionId: string,
    operation: BrowserBackendOperation,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.reject(new Error("Desktop browser backend lost"));
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new Error("Desktop browser session closed"));
    if (this.pending.size >= 128) return Promise.reject(new Error("Browser relay request limit"));
    const id = String(++this.sequence);
    const message: BrowserBackendRequest = {
      type: "browser.backend.request",
      backendId: this.id,
      sessionId,
      id,
      operation,
    };
    return new Promise((resolve, reject) => {
      const cancelTimer = this.clock.set(
        operation.kind === "open"
          ? 60_000
          : operation.kind === "cdp" && operation.method === "Page.navigate"
            ? 95_000
            : 30_000,
        () => {
          signal?.removeEventListener("abort", abort);
          this.pending.delete(id);
          session.pending.delete(id);
          reject(new Error("Desktop browser command timed out"));
          // Uncertain work belongs to this session, never to its siblings.
          this.loseSession(sessionId, "Desktop browser command timed out");
          try {
            this.send({
              type: "browser.backend.request",
              backendId: this.id,
              sessionId,
              id: String(++this.sequence),
              operation: { kind: "close" },
            });
          } catch {
            /* Transport loss already closes sessions. */
          }
        },
      );
      const cancel = () => {
        cancelTimer();
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cancel();
        this.pending.delete(id);
        session.pending.delete(id);
        reject(signal?.reason ?? new Error("Desktop browser command cancelled"));
      };
      this.pending.set(id, { sessionId, resolve, reject, cancel });
      session.pending.add(id);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        this.send(message);
      } catch (error) {
        cancel();
        this.pending.delete(id);
        session.pending.delete(id);
        reject(error);
      }
    });
  }
  handle(raw: unknown): void {
    const message = BrowserBackendClientMessage.parse(raw);
    if (message.type === "browser.backend.register" || message.backendId !== this.id || this.closed)
      return;
    if (message.type === "browser.backend.response") {
      const waiter = this.pending.get(message.id);
      if (!waiter || waiter.sessionId !== message.sessionId) return;
      this.pending.delete(message.id);
      this.sessions.get(waiter.sessionId)?.pending.delete(message.id);
      waiter.cancel();
      if (message.error !== undefined) waiter.reject(new Error(message.error));
      else waiter.resolve(message.result);
      return;
    }
    const session = this.sessions.get(message.sessionId);
    if (!session) return;
    if (message.method === "Page.screencastFrame") {
      const frame = Screencast.safeParse(message.params);
      if (!frame.success || frame.data.data.length > 768 * 1024) {
        this.disconnect("Desktop browser frame exceeds relay limit");
        return;
      }
      // Desktop acknowledges Chromium itself, before replacing its latest frame.
      session.events.emit(message.method, message.params);
      this.send({
        type: "browser.backend.frameAck",
        backendId: this.id,
        sessionId: message.sessionId,
        frameId: frame.data.sessionId,
      });
      return;
    }
    if (message.method === "ace.webSocketRequested") {
      const request = z
        .object({ id: z.string().max(256), url: z.string().max(8192) })
        .safeParse(message.params);
      if (!request.success) return;
      void session.request
        .allowed(request.data.url)
        .catch(() => false)
        .then((allowed) =>
          this.call(message.sessionId, {
            kind: "cdp",
            method: "ace.webSocketDecision",
            params: { id: request.data.id, allowed },
          }),
        )
        .catch(() => {});
      return;
    }
    if (message.method === "ace.permissionDenied") {
      const result = z
        .object({ origin: z.string().max(8192), permission: z.string().max(256) })
        .safeParse(message.params);
      if (result.success) session.request.permissionDenied?.(result.data);
      return;
    }
    if (message.method === "ace.downloadDenied") {
      const result = z
        .object({ url: z.string().max(8192), suggestedFilename: z.string().max(256) })
        .safeParse(message.params);
      if (result.success) session.request.downloadDenied?.(result.data);
      return;
    }
    if (message.method === "Page.frameNavigated") {
      const parsed = Navigation.safeParse(message.params);
      if (parsed.success && !parsed.data.frame.parentId) {
        session.url = parsed.data.frame.url;
        session.request.navigation();
      }
    }
    if (message.method === "Runtime.consoleAPICalled") {
      const parsed = Console.safeParse(message.params);
      if (parsed.success)
        session.request.log({
          kind: "console",
          type: parsed.data.type,
          text: parsed.data.args
            .map((arg) => String(arg.value ?? arg.description ?? "").slice(0, 8192))
            .join(" ")
            .slice(0, 8192),
        });
    }
    if (message.method === "Runtime.exceptionThrown") {
      const parsed = z
        .object({ exceptionDetails: z.object({ text: z.string().max(8192) }) })
        .safeParse(message.params);
      if (parsed.success)
        session.request.log({
          kind: "console",
          type: "pageerror",
          text: parsed.data.exceptionDetails.text,
        });
    }
    if (message.method === "Network.responseReceived") {
      const parsed = Response.safeParse(message.params);
      if (parsed.success)
        session.request.log({
          kind: "network",
          type: "response",
          text: `${parsed.data.response.status} ${parsed.data.response.url}`,
        });
    }
    if (message.method === "Network.loadingFailed") {
      const parsed = z.object({ errorText: z.string().max(8192) }).safeParse(message.params);
      if (parsed.success)
        session.request.log({ kind: "network", type: "failed", text: parsed.data.errorText });
    }
    if (message.method === "Inspector.detached") {
      this.loseSession(message.sessionId, "Desktop browser view closed");
      return;
    }
    session.events.emit(message.method, message.params);
  }
  private rejectPending(session: RemoteSession, reason: string): void {
    for (const id of session.pending) {
      const waiter = this.pending.get(id);
      if (!waiter) continue;
      this.pending.delete(id);
      waiter.cancel();
      waiter.reject(new Error(reason));
    }
    session.pending.clear();
  }
  private loseSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.rejectPending(session, reason);
    session.cleanup();
    session.request.lost(reason);
  }
  disconnect(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.lost();
    for (const sessionId of this.sessions.keys()) {
      try {
        this.loseSession(sessionId, reason);
      } catch {
        /* Notify every sibling on transport loss. */
      }
    }
    this.transport.close(reason);
  }
  async open(request: BackendOpen): Promise<BrowserBackendSession> {
    if (this.closed || this.sessions.size >= 8)
      throw new Error("Embedded browser unavailable or session limit");
    request.signal.throwIfAborted();
    const sessionId = `${this.id}-${++this.sequence}`;
    const remote: RemoteSession = {
      events: new EventEmitter(),
      request,
      url: "about:blank",
      pending: new Set(),
      cleanup() {},
    };
    this.sessions.set(sessionId, remote);
    const call = (operation: BrowserBackendOperation) =>
      closing && operation.kind !== "close"
        ? Promise.reject(new Error("Desktop browser session closed"))
        : this.call(sessionId, operation);
    const cdp = {
      send: (method: string, params?: Record<string, unknown>) =>
        method === "Page.screencastFrameAck"
          ? Promise.resolve(undefined)
          : call({ kind: "cdp", method, ...(params ? { params } : {}) }),
      on: (method: string, listener: (raw: unknown) => void) => remote.events.on(method, listener),
      off: (method: string, listener: (raw: unknown) => void) =>
        remote.events.off(method, listener),
    };
    let viewport = { width: 1280, height: 720 };
    let closing: Promise<void> | undefined;
    let guard: Awaited<ReturnType<typeof installOriginGuard>> | undefined;
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        remote.cleanup();
        this.rejectPending(remote, "Desktop browser session closed");
        // A disconnected bridge has already destroyed all pending commands.
        try {
          if (!this.closed && this.sessions.has(sessionId)) await call({ kind: "close" });
        } catch (error) {
          // Shutdown may disconnect the relay after sending close. That loss already
          // cancels every pending command, and must not turn teardown into a failure.
          if (!this.closed && this.sessions.has(sessionId)) throw error;
        } finally {
          this.sessions.delete(sessionId);
          remote.events.removeAllListeners();
        }
      })());
    const abort = () => {
      void close().catch(() => {});
    };
    remote.cleanup = () => {
      request.signal.removeEventListener("abort", abort);
      guard?.close();
      remote.events.removeAllListeners();
    };
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      const opened = z.object({ url: z.string().max(8192) }).parse(
        await call({
          kind: "open",
          options: request.options,
          viewport,
          lease: { generation: 0, controller: "agent" },
        }),
      );
      remote.url = opened.url;
      request.signal.throwIfAborted();
      guard = await installOriginGuard(cdp, request.allowed, request.initiator);
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Network.enable");
      return {
        cdp,
        url: () => remote.url,
        navigate: async (url, _timeout, signal) => {
          const navigationSignal = signal ?? request.signal;
          await navigateCdp(
            {
              ...cdp,
              send: (method, params) =>
                method === "Page.navigate"
                  ? this.call(
                      sessionId,
                      { kind: "cdp", method, ...(params ? { params } : {}) },
                      navigationSignal,
                    )
                  : cdp.send(method, params),
            },
            url,
            navigationSignal,
          );
        },
        async click(x, y) {
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x,
            y,
            button: "left",
            clickCount: 1,
          });
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x,
            y,
            button: "left",
            clickCount: 1,
          });
        },
        insertText: async (text) => {
          await cdp.send("Input.insertText", { text });
        },
        press: async (key) => {
          await call({ kind: "press", key });
        },
        wheel: async (deltaX, deltaY) => {
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: 0,
            y: 0,
            deltaX,
            deltaY,
          });
        },
        async screenshot(format) {
          const result = z.object({ data: z.string().max(768 * 1024) }).parse(
            await cdp.send("Page.captureScreenshot", {
              format,
              ...(format === "jpeg" ? { quality: 70 } : {}),
            }),
          );
          return Buffer.from(result.data, "base64");
        },
        resize: async (width, height) => {
          await call({ kind: "resize", width, height });
          viewport = { width, height };
        },
        viewport: () => viewport,
        media: async (colorScheme) => {
          await cdp.send("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-color-scheme", value: colorScheme }],
          });
        },
        controller: async (lease) => {
          await call({ kind: "controller", lease });
        },
        close,
      };
    } catch (error) {
      await close().catch(() => {});
      throw error;
    }
  }
}
