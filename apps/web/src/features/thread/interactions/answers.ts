import { InteractionResolution } from "@ace/protocol";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { useSyncExternalStore } from "react";
import { pendingAnswers, usePendingAnswer } from "./pending-answers.ts";
import { z } from "zod";

/*
 * Answers given on this device, by interaction id: in flight (`pending-answers.ts`, `sending`)
 * or accepted by the daemon (`sent`), remembered across reloads with the identity of the
 * request they answered (`requestIdentity`). The same request offered again under the same id
 * after a restart (A3) still reads as answered; a different request never does.
 */

export interface LocalAnswer {
  resolution: InteractionResolution;
  state: "sending" | "sent";
  at: number;
  /** The request it answered; an answer only counts for the same request. */
  identity: string | undefined;
}

export const answerStorageKey = "ace.answers.v1";
/** Enough to cover every thread's recent requests; the oldest go first. */
const remembered = 300;

/** What is stored: bounded, and parsed on the way in, since storage is outside our control. */
const Stored = z
  .array(
    z.tuple([
      z.string().min(1).max(512),
      z.object({
        resolution: InteractionResolution,
        at: z.number().finite(),
        identity: z.string().max(1024).optional(),
      }),
    ]),
  )
  .max(remembered);

export interface AnswerStore {
  get(interactionId: string): LocalAnswer | undefined;
  /** The daemon accepted `resolution` for the request `identity`: remember it. */
  remember(interactionId: string, resolution: InteractionResolution, identity?: string): void;
  /** Forget a remembered answer so the request can be answered again. */
  forget(interactionId: string): void;
  forgetAll(): void;
  subscribe(listener: () => void): () => void;
}

export function createAnswerStore(options: {
  storage: KeyValueStorage | undefined;
  now: () => number;
}): AnswerStore {
  const answers = new Map<string, LocalAnswer>();
  const listeners = new Set<() => void>();
  let loaded = false;
  const load = () => {
    if (loaded) return;
    loaded = true;
    // A corrupt or foreign value is dropped as a whole: nothing remembered beats a crash.
    for (const [id, entry] of readJson(options.storage, answerStorageKey, Stored, []))
      answers.set(id, {
        resolution: entry.resolution,
        at: entry.at,
        identity: entry.identity,
        state: "sent",
      });
  };
  const persist = () =>
    writeJson(
      options.storage,
      answerStorageKey,
      [...answers]
        .slice(-remembered)
        .map(([id, answer]) => [
          id,
          { resolution: answer.resolution, at: answer.at, identity: answer.identity },
        ]),
    );
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    get(interactionId) {
      load();
      return answers.get(interactionId);
    },
    remember(interactionId, resolution, identity) {
      load();
      answers.delete(interactionId);
      answers.set(interactionId, { resolution, state: "sent", at: options.now(), identity });
      for (const id of answers.keys()) {
        if (answers.size <= remembered) break;
        answers.delete(id);
      }
      persist();
      changed();
    },
    forget(interactionId) {
      load();
      if (!answers.delete(interactionId)) return;
      persist();
      changed();
    },
    forgetAll() {
      answers.clear();
      options.storage?.removeItem?.(answerStorageKey);
      changed();
    },
    subscribe(listener) {
      load();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function browserStorage(): KeyValueStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** This device's answers. */
export const answerStore = createAnswerStore({ storage: browserStorage(), now: () => Date.now() });

/**
 * This device's answer to `interactionId`: the pick on its way, else the remembered answer if it
 * answered the same request (`identity`); one remembered for a different request is ignored.
 */
export function useLocalAnswer(
  interactionId: string | undefined,
  identity?: string | undefined,
): LocalAnswer | undefined {
  const pending = usePendingAnswer(interactionId);
  const answer = useSyncExternalStore(
    answerStore.subscribe,
    () => (interactionId ? answerStore.get(interactionId) : undefined),
    () => undefined,
  );
  if (pending) return { resolution: pending, state: "sending", at: 0, identity };
  if (!answer || answer.identity !== identity) return undefined;
  return answer;
}

export { pendingAnswers };
