import { AsyncLocalStorage } from "node:async_hooks";

/*
 * Shared machinery (worker threads, pools, their idle timers) belongs to no caller. Created inside
 * one caller's async context, Node runs its later events in that context, so a crash there would
 * be charged to whoever happened to create it (the daemon charges fatal errors to the service
 * whose context raised them, ADR 0175). It is created in the empty context instead, and work done
 * for one request runs in that request's own context.
 */

/** The empty context, captured when this module first loads, before any caller's work runs. */
const root = AsyncLocalStorage.snapshot();

/** Runs `create` outside every caller's async context. */
export function unscoped<T>(create: () => T): T {
  return root(create);
}

/** Runs work in the context of the caller that asked for it. */
export type RequestOwner = <T>(work: () => T) => T;

/** The current caller's context, to hand a request's later work back to it. */
export function requestOwner(): RequestOwner {
  return AsyncLocalStorage.snapshot();
}
