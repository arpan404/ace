// SPDX-License-Identifier: Apache-2.0
/**
 * The native facade's contract: the addon handle, the store shell, and the one incomplete-error
 * helper every not-yet-ported member throws. Kept apart so the facade file is one responsibility.
 */
import { appendFileSync } from "node:fs";
import type { EngineBindings } from "./ports.ts";
import type { OpenFrame } from "../native-writer/transaction.ts";

/** The store's transaction shell, for Rust-opened transactions. */
export interface NativeTransactionShell {
  open(): OpenFrame;
  close(
    frame: OpenFrame | number,
    result: { threw: false } | { threw: true; error: unknown },
  ): void;
  appendEvents(json: string): void;
  readonly transactionOpen: boolean;
}

/** The addon's engine handle: each member an item adds is optional until it lands. */
export interface NativeEngineHandle {
  pump?(): "rearm" | "done";
  startFlush?(call: number): void;
  close?(): void;
  settleCall?(call: number, error: string | null): void;
  ensureProvider?(provider: string, call: number): void;
  providerAvailability?(provider: string): string;
  capabilities?(provider: string, backend?: string): string;
  registryChanged?(json: string): void;
  timerFired?(key: number): void;
  settlePromise?(id: number, ok: boolean, message?: string): void;
  onLimitPolicy?(id: number, listener: (id: string) => void): void;
  dropLimitPolicy?(id: number): void;
  pumpStats?(): { turns: number; polls: number; longestPollUs: number; slowPolls: number };
  hold?(): void;
  releaseHold?(): void;
  release?(): void;
  // E5.2's members: the actor, its frames and its flow.
  liveThreadIds?(): string[];
  workload?(): string;
  rootAgent?(threadId: string): string | undefined;
  actorFrame?(
    threadId: string,
    generation: number,
    handle: number,
    frame: unknown,
    isObject: boolean,
    branded: boolean,
    certified: boolean,
    bytes: number | null,
    error: string | null,
  ): string;
  actorPaused?(threadId: string): boolean;
  actorWait?(threadId: string, call: number): void;
  actorFlushDue?(): void;
  actorQuarantine?(threadId: string, message: string): void;
  persistLive?(token: number): void;
  committedLive?(token: number): void;
  discardLive?(token: number): void;
  attachTranslatorHelper?(helper: (thread: string, request: string) => string): void;
  attachLiveStore?(hooks: Record<string, unknown>): void;
  [member: string]: unknown;
}

export type Settled = {
  resolve: (value: undefined) => void;
  reject: (error: Error) => void;
};

export interface DatabaseHandle {
  nativeEngine(bindings: EngineBindings, pump: () => void): NativeEngineHandle;
}

/** `NativeEngineIncomplete: <what> lands in E5.<n>`. */
export function incomplete(what: string, item: string): Error {
  return new Error(`NativeEngineIncomplete: ${what} lands in ${item}`);
}

export function closed(): Error {
  return Object.assign(new Error("Engine closed"), { code: "ACE_ENGINE_CLOSED" });
}

let evidenceWritten = false;

export function recordEvidence(): void {
  if (evidenceWritten) return;
  const path = process.env.ACE_ENGINE_EVIDENCE;
  if (path === undefined) return;
  appendFileSync(path, `${process.pid} engine\n`);
  evidenceWritten = true;
}
