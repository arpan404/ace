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
  data?: unknown;
}

/** The session's frames, held by handle for the batch that will translate them. */
export class FrameTable {
  private readonly frames = new Map<number, Frame>();
  private readonly translators = new Map<string, Translator>();
  private next = 1;

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

  /**
   * The binding's one call per batch. For each handle in order it calls the session's
   * `translate(frame, now)` and then `takeDiagnostics()`, so the per-frame clock and the order
   * of translate and diagnostics are the TypeScript's.
   */
  translate(threadId: string, requestJson: string): string {
    const request = JSON.parse(requestJson) as {
      now?: number;
      frames?: number[];
      tick?: number;
      nextDeadline?: boolean;
    };
    const translator = this.translators.get(threadId);
    if (request.nextDeadline) return JSON.stringify(translator?.nextDeadline?.() ?? null);
    if (request.tick !== undefined) return JSON.stringify(translator?.tick(request.tick) ?? []);
    const now = request.now ?? 0;
    const out: Translated[] = [];
    for (const handle of request.frames ?? []) {
      const frame = this.frames.get(handle);
      this.frames.delete(handle);
      if (frame === undefined) {
        out.push({ facts: [], diagnostics: [] });
        continue;
      }
      const facts = translator?.translate(frame, now) ?? [];
      const diagnostics = translator?.takeDiagnostics?.() ?? [];
      const entry: Translated = { facts, diagnostics };
      // The Cursor SDK path needs the frame's own data in Rust: the record and the send test.
      if (frame.channel === "sdk") entry.data = frame.data;
      out.push(entry);
    }
    return JSON.stringify(out);
  }
}

/** What `onFrame` needs from the engine's facade: one promise per batch, by call id. */
export interface FramePromises {
  frameCall(): { promise: Promise<void>; call: number };
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
  // One promise per batch (decision 4): every frame that joins the open batch gets it.
  let batchPromise: Promise<void> | undefined;
  return {
    onFrame(frame: Frame): Promise<void> {
      const input = frame as unknown;
      const isObject = typeof input === "object" && input !== null;
      const data = isObject ? (input as Frame) : undefined;
      const certified =
        data !== undefined && ProviderPayload.is(data.payload) && data.payload.data === data.data;
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
      const { promise, call } = threads.frameCall();
      if (batchPromise === undefined) {
        batchPromise = promise;
        void promise.then(
          () => {
            batchPromise = undefined;
          },
          () => {
            batchPromise = undefined;
          },
        );
      }
      const answer = native.actorFrame?.(
        threadId,
        generation,
        handle,
        data ?? {},
        isObject,
        certified,
        bytes,
        error,
        call,
      ) as string | undefined;
      if (answer === undefined) return Promise.resolve();
      if (answer === "done") return Promise.resolve();
      if (answer.startsWith("rejected:")) {
        return Promise.reject(new Error(answer.slice("rejected:".length)));
      }
      // Every frame that joined the open batch settles with it.
      return batchPromise ?? promise;
    },
    outputFlow: {
      paused: () => native.actorPaused?.(threadId) ?? false,
      wait: () =>
        new Promise<void>((resolve) => {
          const { promise, call } = threads.frameCall();
          native.actorWait?.(threadId, call);
          void promise.then(
            () => resolve(),
            () => resolve(),
          );
        }),
    },
  };
}
