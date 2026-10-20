import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerEvent, ServerEventBus } from "@modelcontextprotocol/server";
import type { Principal } from "./credentials.ts";

/** Listen streams one lease keeps open; a newer stream from the lease closes its oldest. */
export const listenStreamsPerLease = 2;

/** One request being served, and, for a listen request, the switch that closes its stream. */
type Serving = { principal: Principal; stream?: AbortController };

/**
 * The MCP handler's change-event bus, aware of whose subscription each listener is. The SDK
 * subscribes a `subscriptions/listen` stream while serving its request, so running each request
 * inside `serving` tags the listener with that request's lease. `publishTo` then reaches only
 * one session's streams: a session that opens a family reloads its own list, and every other
 * session keeps its prompt cache. `publish` still reaches every stream, for changes that
 * concern all sessions (a group turned on or off).
 *
 * Listen streams are bounded per lease rather than only server-wide: a lease holds at most
 * `perLease` streams, and a new one closes its oldest, so a client that reconnects without
 * closing its old stream is never refused. A stream served through `listening` also closes when
 * its lease ends.
 */
export class PrincipalEventBus implements ServerEventBus {
  private readonly current = new AsyncLocalStorage<Serving>();
  private readonly listeners = new Map<(event: ServerEvent) => void, Principal | undefined>();
  private readonly streams = new Map<Principal, Set<AbortController>>();
  private readonly perLease: number;
  private readonly report: (error: unknown) => void;
  constructor(options: { perLease?: number; report?: (error: unknown) => void } = {}) {
    this.perLease = Math.max(1, options.perLease ?? listenStreamsPerLease);
    this.report = options.report ?? (() => {});
  }
  /** Runs one request for this lease; a stream it subscribes belongs to the lease. */
  serving<T>(principal: Principal | undefined, run: () => T): T {
    return principal ? this.current.run({ principal }, run) : run();
  }
  /**
   * Runs one `subscriptions/listen` request for this lease. Its oldest streams close first to
   * leave room for this one, so a reconnect is admitted even when the server-wide cap is
   * otherwise full. Serve the request with `signal`: it aborts when the lease ends or a newer
   * stream from the same lease replaces this one.
   */
  listening<T>(principal: Principal, run: (signal: AbortSignal) => T): T {
    this.trim(principal, this.perLease - 1);
    const stream = new AbortController();
    return this.current.run({ principal, stream }, () =>
      run(AbortSignal.any([principal.signal, stream.signal])),
    );
  }
  subscribe(listener: (event: ServerEvent) => void): () => void {
    const serving = this.current.getStore();
    this.listeners.set(listener, serving?.principal);
    const stream = serving?.stream;
    if (serving && stream) {
      let owned = this.streams.get(serving.principal);
      if (!owned) {
        owned = new Set();
        this.streams.set(serving.principal, owned);
      }
      owned.add(stream);
      // Concurrent listens from one lease can each pass `listening` before either subscribes.
      this.trim(serving.principal, this.perLease);
    }
    return () => {
      this.listeners.delete(listener);
      if (serving && stream) this.release(serving.principal, stream);
    };
  }
  publish(event: ServerEvent): void {
    this.deliver(event, () => true);
  }
  publishTo(principal: Principal, event: ServerEvent): void {
    this.deliver(event, (owner) => owner === principal);
  }
  /** Closes this lease's oldest streams until at most `keep` remain. */
  private trim(principal: Principal, keep: number): void {
    const owned = this.streams.get(principal);
    if (!owned) return;
    for (const stream of [...owned]) {
      if (owned.size <= keep) break;
      // Aborting tears the stream down, which unsubscribes and releases it; release it here
      // too so the count is right even if the SDK defers its teardown.
      this.release(principal, stream);
      stream.abort();
    }
  }
  private release(principal: Principal, stream: AbortController): void {
    const owned = this.streams.get(principal);
    if (!owned?.delete(stream)) return;
    if (!owned.size) this.streams.delete(principal);
  }
  private deliver(event: ServerEvent, accepts: (owner: Principal | undefined) => boolean): void {
    for (const [listener, owner] of this.listeners)
      if (accepts(owner))
        try {
          listener(event);
        } catch (error) {
          this.report(error);
        }
  }
}
