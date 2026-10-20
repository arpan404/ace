import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerEvent, ServerEventBus } from "@modelcontextprotocol/server";
import type { Principal } from "./credentials.ts";

/**
 * The MCP handler's change-event bus, aware of whose subscription each listener is. The SDK
 * subscribes a `subscriptions/listen` stream while serving its request, so running each request
 * inside `serving` tags the listener with that request's lease. `publishTo` then reaches only
 * one session's streams: a session that opens a family reloads its own list, and every other
 * session keeps its prompt cache. `publish` still reaches every stream, for changes that
 * concern all sessions (a group turned on or off).
 */
export class PrincipalEventBus implements ServerEventBus {
  private readonly current = new AsyncLocalStorage<Principal>();
  private readonly listeners = new Map<(event: ServerEvent) => void, Principal | undefined>();
  private readonly onerror: (error: unknown) => void;
  constructor(onerror: (error: unknown) => void = () => {}) {
    this.onerror = onerror;
  }
  /** Runs one request for this lease; a stream it subscribes belongs to the lease. */
  serving<T>(principal: Principal | undefined, run: () => T): T {
    return principal ? this.current.run(principal, run) : run();
  }
  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.set(listener, this.current.getStore());
    return () => {
      this.listeners.delete(listener);
    };
  }
  publish(event: ServerEvent): void {
    this.deliver(event, () => true);
  }
  publishTo(principal: Principal, event: ServerEvent): void {
    this.deliver(event, (owner) => owner === principal);
  }
  private deliver(event: ServerEvent, accepts: (owner: Principal | undefined) => boolean): void {
    for (const [listener, owner] of [...this.listeners])
      if (accepts(owner))
        try {
          listener(event);
        } catch (error) {
          this.onerror(error);
        }
  }
}
