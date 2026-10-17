import { EventEmitter } from "node:events";
import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import { CommandSlots } from "./command-slots.ts";

export type CdpSend = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;
/** Test and diagnostics edge around the wire; production passes none. */
export interface CdpIntercept {
  /** Wraps each outgoing command after it holds a slot. */
  send?(send: CdpSend): CdpSend;
  /** Observes each incoming event before listeners run. */
  event?(method: string, params: unknown, sessionId: string): void;
}
export type Schedule = (work: () => void, milliseconds: number) => () => void;
export interface CdpConnectionOptions {
  write(message: string): void;
  schedule: Schedule;
  /** Called once when a timed-out command is followed by a failed liveness probe. */
  hung(reason: string): void;
  commandTimeoutMs?: number;
  probeTimeoutMs?: number;
  intercept?: CdpIntercept;
}
export interface CdpCommandOptions {
  sessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}
const Message = z.object({
  id: z.number().int().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
  sessionId: z.string().optional(),
});
const Detached = z.object({ sessionId: z.string() });
interface Pending {
  sessionId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * One CDP client over a message transport, with flattened target sessions.
 * Every command has a deadline. A timeout fails only that command, then a root ping tells
 * a slow page from a wedged browser; only a failed ping reports the connection as hung.
 */
export class CdpConnection {
  private pending = new Map<number, Pending>();
  private emitters = new Map<string, EventEmitter>();
  private facades = new Map<string, BrowserCdp>();
  private slots = new CommandSlots(256, 4096);
  private nextId = 0;
  private reason: string | undefined;
  private probing = false;
  private options: CdpConnectionOptions;
  constructor(options: CdpConnectionOptions) {
    this.options = options;
  }
  get closed(): boolean {
    return this.reason !== undefined;
  }
  send(
    method: string,
    params?: Record<string, unknown>,
    options: CdpCommandOptions = {},
  ): Promise<unknown> {
    if (this.reason) return Promise.reject(new Error(this.reason));
    const timeoutMs = options.timeoutMs ?? this.options.commandTimeoutMs ?? 60_000;
    return this.slots.run(() => {
      const next: CdpSend = (name, values, sessionId) =>
        this.transmit(name, values, sessionId ?? "", timeoutMs, options.signal, true);
      const send = this.options.intercept?.send?.(next) ?? next;
      return send(method, params, options.sessionId);
    }, options.signal);
  }
  /** A stable command surface for one flattened target session. */
  session(sessionId: string): BrowserCdp {
    let facade = this.facades.get(sessionId);
    if (facade) return facade;
    const events = this.emitter(sessionId);
    facade = {
      send: (method, params) => this.send(method, params, { sessionId }),
      on: (method, listener) => events.on(method, listener),
      off: (method, listener) => events.off(method, listener),
    };
    this.facades.set(sessionId, facade);
    return facade;
  }
  /** Drops a detached session's listeners and fails its outstanding commands. */
  forget(sessionId: string): void {
    this.rejectSession(sessionId, "Browser target detached");
    this.emitters.get(sessionId)?.removeAllListeners();
    this.emitters.delete(sessionId);
    this.facades.delete(sessionId);
  }
  receive(text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const message = Message.safeParse(raw);
    if (!message.success) return;
    const { id, method, params, sessionId = "" } = message.data;
    if (id !== undefined) {
      const waiter = this.pending.get(id);
      if (!waiter) return;
      if (message.data.error)
        waiter.reject(new Error(message.data.error.message ?? "Browser command failed"));
      else waiter.resolve(message.data.result);
      return;
    }
    if (!method) return;
    try {
      this.options.intercept?.event?.(method, params, sessionId);
    } catch {
      /* Observers cannot break delivery. */
    }
    if (method === "Target.detachedFromTarget" && !sessionId) {
      const detached = Detached.safeParse(params);
      if (detached.success) this.rejectSession(detached.data.sessionId, "Browser target detached");
    }
    this.emitters.get(sessionId)?.emit(method, params);
  }
  close(reason: string): void {
    if (this.reason) return;
    this.reason = reason;
    for (const waiter of this.pending.values()) waiter.reject(new Error(reason));
    this.pending.clear();
    for (const events of this.emitters.values()) events.removeAllListeners();
    this.emitters.clear();
    this.facades.clear();
  }
  private emitter(sessionId: string): EventEmitter {
    let events = this.emitters.get(sessionId);
    if (!events) {
      events = new EventEmitter();
      events.setMaxListeners(0);
      this.emitters.set(sessionId, events);
    }
    return events;
  }
  private rejectSession(sessionId: string, reason: string): void {
    for (const waiter of this.pending.values())
      if (waiter.sessionId === sessionId) waiter.reject(new Error(reason));
  }
  private transmit(
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    probes: boolean,
  ): Promise<unknown> {
    if (this.reason) return Promise.reject(new Error(this.reason));
    if (signal?.aborted)
      return Promise.reject(signal.reason ?? new Error("Browser command cancelled"));
    const id = ++this.nextId;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const settle = () => {
      this.pending.delete(id);
      cancel();
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      settle();
      reject(signal?.reason ?? new Error("Browser command cancelled"));
    };
    const cancel = this.options.schedule(() => {
      settle();
      reject(new Error(`Browser command timed out: ${method}`));
      if (probes) this.probe();
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    this.pending.set(id, {
      sessionId,
      resolve: (value) => {
        settle();
        resolve(value);
      },
      reject: (error) => {
        settle();
        reject(error);
      },
    });
    try {
      this.options.write(
        JSON.stringify({
          id,
          method,
          ...(params ? { params } : {}),
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    } catch (error) {
      settle();
      reject(error instanceof Error ? error : new Error("Browser pipe write failed"));
    }
    return promise;
  }
  /** Bypasses slots: a full backlog is exactly when liveness must still be checked. */
  private probe(): void {
    if (this.probing || this.reason) return;
    this.probing = true;
    this.transmit(
      "Browser.getVersion",
      undefined,
      "",
      this.options.probeTimeoutMs ?? 5_000,
      undefined,
      false,
    ).then(
      () => {
        this.probing = false;
      },
      () => {
        this.probing = false;
        if (!this.reason) this.options.hung("The browser stopped responding");
      },
    );
  }
}
