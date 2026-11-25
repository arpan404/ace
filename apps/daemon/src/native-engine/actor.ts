// SPDX-License-Identifier: Apache-2.0
/**
 * The frame table and the translator helper (E5.2 step 13). The frame object stays JavaScript's:
 * the table holds it under a handle, and one call per batch translates the batch.
 */
import type { Frame, Translator } from "@ace/engine-api";
import type { Fact } from "@ace/core";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { boundedJson } from "@ace/provider-kit/ipc";
import type { NativeEngineHandle } from "./engine.ts";

/** One translated frame, as the binding reads it. */
interface Translated {
  facts: Fact[];
  diagnostics: unknown[];
  frame?: Frame;
  usageAccount?: Frame["usageAccount"];
}

/** The session's frames, held by handle for the batch that will translate them. */
export class FrameTable {
  private readonly frames = new Map<number, Frame>();
  private readonly translators = new Map<string, Translator>();
  private readonly now: () => number;
  private next = 1;
  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  attach(threadId: string, translator: Translator): void {
    this.translators.set(threadId, translator);
  }
  detach(threadId: string): void {
    this.translators.delete(threadId);
  }
  translatorOf(threadId: string): Translator | undefined {
    return this.translators.get(threadId);
  }
  add(frame: Frame): number {
    const handle = this.next++;
    this.frames.set(handle, frame);
    return handle;
  }
  release(handle: number): void {
    this.frames.delete(handle);
  }
  /** Handles the engine released in one batch: those frames will never translate. */
  releaseHandles(handles: readonly number[]): void {
    for (const handle of handles) this.frames.delete(handle);
  }
  /** Frames still held: a batch that never settles would leak one. */
  get size(): number {
    return this.frames.size;
  }

  /**
   * The binding's one call per batch. For each handle in order it calls the session's
   * `translate(frame, now)` and then `takeDiagnostics()`, so the per-frame clock and the order
   * of translate and diagnostics are the TypeScript's.
   */
  translate(threadId: string, requestJson: string): string {
    const request = JSON.parse(requestJson) as {
      frames?: number[];
      tick?: number;
      nextDeadline?: boolean;
    };
    const translator = this.translators.get(threadId);
    if (request.nextDeadline) return JSON.stringify(translator?.nextDeadline?.() ?? null);
    if (request.tick !== undefined) return JSON.stringify(translator?.tick(request.tick) ?? []);
    const out: Translated[] = [];
    for (const handle of request.frames ?? []) {
      const frame = this.frames.get(handle);
      this.frames.delete(handle);
      if (frame === undefined) {
        out.push({ facts: [], diagnostics: [] });
        continue;
      }
      // The TypeScript reads the clock per frame, so two frames of one batch can see two times.
      const facts = translator?.translate(frame, this.now()) ?? [];
      const diagnostics = translator?.takeDiagnostics?.() ?? [];
      const entry: Translated = { facts, diagnostics };
      // The Cursor SDK path needs the whole frame in Rust: its record, the send test and its
      // account (`actor.ts:475`–`:491`).
      if (frame.channel === "sdk") entry.frame = frame;
      // A usage fact carries the frame's own account, whichever channel it came from.
      entry.usageAccount = frame.usageAccount;
      out.push(entry);
    }
    return JSON.stringify(out);
  }
}

/** What `onFrame` needs from the engine's facade: one promise per batch, by call id. */
export interface FramePromises {
  /** Allocates one promise for the batch a frame starts; its call id settles it. */
  alloc(): number;
  promiseOf(call: number): Promise<void> | undefined;
}

/** What a bound context hands a session. */
export interface ActorContext {
  onFrame(frame: Frame): Promise<void>;
  outputFlow: { paused(): boolean; wait(): Promise<void> };
}

/**
 * `actorContext`: the frame entry and the output flow a TypeScript session's context gets, built
 * exactly as E5.6 will build it.
 */
export function actorContext(
  native: NativeEngineHandle,
  frames: FrameTable,
  threads: FramePromises,
  threadId: string,
  generation: number,
  maxFrameBytes: number,
): ActorContext {
  native.attachTranslatorHelper?.((thread: string, request: string) =>
    frames.translate(thread, request),
  );
  return {
    onFrame(frame: Frame): Promise<void> {
      const input = frame as unknown;
      const isObject = typeof input === "object" && input !== null;
      const data = isObject ? (input as Frame) : undefined;
      // The brand is the envelope's payload check; the data equality is the certificate's.
      const branded = data !== undefined && ProviderPayload.is(data.payload);
      const certified = branded && data.payload!.data === data.data;
      let handle = 0;
      let bytes: number | null = null;
      let error: string | null = null;
      if (data !== undefined) {
        handle = frames.add(data);
        if (certified) {
          bytes = data.payload!.bytes;
        } else {
          try {
            bytes = Buffer.byteLength(boundedJson(data, maxFrameBytes));
          } catch (thrown) {
            error = String((thrown as Error).message ?? thrown);
          }
        }
      }
      let answer: string | undefined;
      try {
        // The binding allocates one promise per batch and names it in its answer; a joined
        // frame allocates nothing.
        answer = native.actorFrame?.(
          threadId,
          generation,
          handle,
          data ?? {},
          isObject,
          branded,
          certified,
          bytes,
          error,
        ) as string | undefined;
      } catch (thrown) {
        frames.release(handle);
        throw thrown;
      }
      if (answer === undefined || answer === "done") {
        frames.release(handle);
        return Promise.resolve();
      }
      if (answer.startsWith("rejected:")) {
        frames.release(handle);
        return Promise.reject(new Error(answer.slice("rejected:".length)));
      }
      if (answer.startsWith("flush:")) {
        // The frame was refused, never translated: its object goes with the promise.
        frames.release(handle);
        return threads.promiseOf(Number(answer.slice("flush:".length))) ?? Promise.resolve();
      }
      // A batch's own promise, by its call id.
      if (answer.startsWith("batch:")) {
        const settled = answer.slice("batch:".length);
        return threads.promiseOf(Number(settled)) ?? Promise.resolve();
      }
      frames.release(handle);
      return Promise.resolve();
    },
    outputFlow: {
      paused: () => native.actorPaused?.(threadId) ?? false,
      wait: () =>
        new Promise<void>((resolve) => {
          const call = threads.alloc();
          native.actorWait?.(threadId, call);
          const promise = threads.promiseOf(call);
          if (promise === undefined) resolve();
          else
            void promise.then(
              () => resolve(),
              () => resolve(),
            );
        }),
    },
  };
}
