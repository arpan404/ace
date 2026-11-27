// SPDX-License-Identifier: Apache-2.0
/**
 * The session bridge every native session shares (E3.0c, ADR 0223 §7 rules 3–4): it turns one
 * batch of the Rust session's ordered events into the engine's calls, in the order the session
 * produced them, and settles the facade's promises from that same queue. The Rust half is
 * `ace-adapter-api/src/bridge.rs` and `ace-daemon-node/src/session_bridge.rs`.
 *
 * Nothing here awaits: a frame's acknowledgement is tracked (a rejected one fails the session),
 * the engine's `outputFlow` is mirrored onto the session's gate, and a reply is settled where it
 * lands, so a reply never overtakes the frame that carried it.
 */

import { warnSafely } from "./native-process.ts";
import { ProviderPayload } from "./payload.ts";

/** How the frame's data reads; the engine-api `Frame`'s `dir`. */
export type SessionFrameDirection = "send" | "recv" | "stderr" | "note";

/** One frame as `ctx.onFrame` takes it (the engine-api `Frame` shape). */
export interface SessionFrame {
  seq: number;
  /** Milliseconds since `hooks.started`, from the adapter's injected clock. */
  t: number;
  dir: SessionFrameDirection;
  channel: string;
  data: unknown;
  payload: ProviderPayload;
}

/**
 * The parts of `@ace/engine-api`'s `SessionContext` a native session drives. Callbacks
 * (`onSessionIdentity`, `onSessionConfirmed`, `onInputMessage`, `onCapabilities`,
 * `onPermissionMode`, …) are dispatched by name from the queue.
 */
export interface SessionContext {
  onFrame(frame: SessionFrame): unknown;
  outputFlow?: { paused(): boolean; wait(): Promise<void> };
}

/** The binding methods the facade calls; `SessionPort` in `session_bridge.rs`. */
export interface NativeSessionPort {
  setPaused(paused: boolean): void;
  fail(): void;
  drain(): void;
}

/** Everything the bridge needs from the adapter, all of it injected (tests replace it). */
export interface BridgeHooks {
  /** The adapter's injected clock. */
  now(): number;
  /** Its value at open, so `t` is milliseconds since the session started. */
  started: number;
  /** The adapter's injected timer; the returned function cancels it. */
  schedule(callback: () => void, ms: number): () => void;
  /** Calls the session handle back when an armed timer fires. */
  timer(key: string): void;
  /** The facade's `close("shutdown", false)`: the session cannot go on. */
  fatal(message: string): void;
  /** The facade's exit path, after `Drained` settled everything before it. */
  drained(): void;
  /**
   * A port the session cannot run itself: the child's stop (the facade owns the process) and a
   * permission mode only the context can answer. Handled synchronously; the answer goes back
   * through the handle.
   */
  port?(name: string, json: string): void;
}

/** The bridge's surface: the port's callback, the facade's promises and the drain signal. */
export interface SessionBridge {
  /**
   * The binding's callback, one encoded batch at a time. napi calls a threadsafe function
   * error-first, so a facade passes `(_error, batch) => bridge.deliver(batch)`.
   */
  deliver(batch: string): void;
  /** Settled by a `Settle` event; `ACE_*` codes map to `errors`' classes. */
  expect(id: number): Promise<unknown>;
  /** Resolves after `Drained` was handled. */
  drainedPromise: Promise<void>;
}

const DIRECTIONS: ReadonlySet<string> = new Set(["send", "recv", "stderr", "note"]);

function isDirection(value: unknown): value is SessionFrameDirection {
  return typeof value === "string" && DIRECTIONS.has(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "then") === "function"
  );
}

/**
 * A throw's message, or fixed text when it cannot be described without throwing: `String()` on a
 * null-prototype object throws, and the reporter must never throw.
 */
function describe(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "a callback threw a value that could not be described";
  }
}

/**
 * `sessionBridge` wires one native session's queue to the engine. Every event is handled in
 * batch order; `Drained` ends the session and nothing is handled after it.
 */
export function sessionBridge(
  ctx: SessionContext,
  port: NativeSessionPort,
  hooks: BridgeHooks,
  errors: Readonly<Record<string, new (message: string) => Error>>,
): SessionBridge {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const timers = new Map<string, () => void>();
  let paused = false;
  let closed = false;
  let settleDrained: (() => void) | undefined;
  const drainedPromise = new Promise<void>((resolve) => {
    settleDrained = resolve;
  });

  /** The engine's flow, mirrored onto the session's gate: the gate answers the next chunk. */
  function mirrorFlow(): void {
    const flow = ctx.outputFlow;
    if (flow === undefined) return;
    if (!flow.paused()) {
      if (!paused) return;
      paused = false;
      port.setPaused(false);
      return;
    }
    if (paused) return;
    paused = true;
    port.setPaused(true);
    void flow.wait().then(() => {
      if (!paused) return;
      paused = false;
      port.setPaused(false);
    });
  }

  function errorFor(code: string | null, message: string): Error {
    if (code === null) return new Error(message);
    const Ctor = Object.hasOwn(errors, code) ? errors[code] : undefined;
    return Ctor === undefined ? new Error(message) : new Ctor(message);
  }

  function frame(fields: readonly unknown[]): void {
    const [seq, dir, channel, text] = fields;
    if (
      typeof seq !== "number" ||
      !isDirection(dir) ||
      typeof channel !== "string" ||
      typeof text !== "string"
    )
      throw new TypeError("native session frame is malformed");
    const payload = new ProviderPayload(text);
    const committed = ctx.onFrame({
      seq,
      t: Math.max(0, Math.round(hooks.now() - hooks.started)),
      dir,
      channel,
      data: payload.data,
      payload,
    });
    // Intake stops on a failed commit, as today: the engine's facts report the failure.
    if (isPromiseLike(committed)) void Promise.resolve(committed).catch(() => port.fail());
    mirrorFlow();
  }

  function callback(fields: readonly unknown[]): void {
    const [name, json] = fields;
    if (typeof name !== "string" || typeof json !== "string")
      throw new TypeError("native session callback is malformed");
    const handler: unknown = Reflect.get(ctx, name);
    if (typeof handler !== "function") return;
    const args: unknown = JSON.parse(json);
    if (!Array.isArray(args))
      throw new TypeError("native session callback is not an argument list");
    handler.apply(ctx, args);
  }

  function settle(fields: readonly unknown[]): void {
    const [id, ok, body, code] = fields;
    if (
      typeof id !== "number" ||
      typeof ok !== "boolean" ||
      typeof body !== "string" ||
      (code !== null && typeof code !== "string")
    )
      throw new TypeError("native session settle is malformed");
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    if (ok) entry.resolve(JSON.parse(body));
    else entry.reject(errorFor(code, body));
  }

  function armTimer(fields: readonly unknown[]): void {
    const [key, ms] = fields;
    if (typeof key !== "string" || typeof ms !== "number")
      throw new TypeError("native session timer is malformed");
    // A re-armed key replaces its timer: the old handle is cancelled first, or it
    // could still call `hooks.timer` after this one stands for the same key.
    const previous = timers.get(key);
    if (previous !== undefined) {
      timers.delete(key);
      previous();
    }
    timers.set(
      key,
      hooks.schedule(() => {
        if (closed) return;
        hooks.timer(key);
      }, ms),
    );
  }

  function cancelTimer(fields: readonly unknown[]): void {
    const [key] = fields;
    if (typeof key !== "string") throw new TypeError("native session timer is malformed");
    const cancel = timers.get(key);
    if (cancel === undefined) return;
    timers.delete(key);
    cancel();
  }

  /** The terminal barrier: every frame, callback and settle arrived before it. */
  function drained(): void {
    closed = true;
    for (const cancel of timers.values()) {
      try {
        cancel();
      } catch (error) {
        warnSafely(`native session timer cancellation failed: ${describe(error)}`);
      }
    }
    timers.clear();
    for (const entry of pending.values()) entry.reject(new Error("session closed"));
    pending.clear();
    const settleBatch = settleDrained;
    settleDrained = undefined;
    settleBatch?.();
    hooks.drained();
  }

  function handle(event: unknown): void {
    if (!Array.isArray(event) || typeof event[0] !== "string")
      throw new TypeError("native session event is not an array");
    const [kind, ...fields] = event;
    switch (kind) {
      case "frame":
        return frame(fields);
      case "callback":
        return callback(fields);
      case "settle":
        return settle(fields);
      case "armTimer":
        return armTimer(fields);
      case "cancelTimer":
        return cancelTimer(fields);
      case "port": {
        const [name, json] = fields;
        if (typeof name !== "string" || typeof json !== "string")
          throw new TypeError("native session port is malformed");
        return hooks.port?.(name, json);
      }
      case "fatal": {
        const [message] = fields;
        if (typeof message !== "string") throw new TypeError("native session fatal is malformed");
        return hooks.fatal(message);
      }
      case "drained":
        return drained();
      default:
        return;
    }
  }

  function deliver(batch: string): void {
    const parsed: unknown = JSON.parse(batch);
    if (!Array.isArray(parsed)) throw new TypeError("native session batch is not an array");
    for (const event of parsed) {
      if (closed) return;
      // Each event stands alone: a throw in one must not skip the rest of its
      // batch, and skipping `Drained` above all would leave the session's
      // promises unsettled and its exit unhooked.
      try {
        handle(event);
      } catch (error) {
        const kind: unknown = Array.isArray(event) ? event[0] : undefined;
        warnSafely(
          `native session ${typeof kind === "string" ? kind : "unknown"} event failed: ${describe(error)}`,
        );
      }
    }
  }

  function expect(id: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      // A session that closed settles nothing more: refuse rather than leave a promise hanging.
      if (closed) reject(new Error("session closed"));
      else pending.set(id, { resolve, reject });
    });
  }

  return { deliver, expect, drainedPromise };
}
