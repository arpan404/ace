import { InteractionResolution } from "@ace/protocol";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { useSyncExternalStore } from "react";
import { z } from "zod";

/*
 * Answers given on this device, by interaction id.
 *
 * - While one travels to the daemon it is `sending`: the card and the step it gates show the
 *   pick at once ("Approved by you"), and revert if the daemon refuses it (IR-2, SY-9).
 * - Once the daemon accepts it, it is `sent` and remembered across reloads with the identity
 *   of the request it answered (`requestIdentity`): the same request offered again under the
 *   same id after a restart (A3) still reads as answered; a different request never does.
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
  /** The person picked `resolution` here; it is on its way. */
  sending(interactionId: string, resolution: InteractionResolution, identity?: string): void;
  /** The daemon accepted the answer. */
  sent(interactionId: string): void;
  /** The answer didn't go through: the card offers the choice again. */
  failed(interactionId: string): void;
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
  const persist = () => {
    const sent = [...answers].filter(([, answer]) => answer.state === "sent").slice(-remembered);
    writeJson(
      options.storage,
      answerStorageKey,
      sent.map(([id, answer]) => [
        id,
        { resolution: answer.resolution, at: answer.at, identity: answer.identity },
      ]),
    );
  };
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    get(interactionId) {
      load();
      return answers.get(interactionId);
    },
    sending(interactionId, resolution, identity) {
      load();
      answers.delete(interactionId);
      answers.set(interactionId, { resolution, state: "sending", at: options.now(), identity });
      changed();
    },
    sent(interactionId) {
      const answer = answers.get(interactionId);
      if (!answer) return;
      answers.set(interactionId, { ...answer, state: "sent" });
      for (const id of answers.keys()) {
        if (answers.size <= remembered) break;
        answers.delete(id);
      }
      persist();
      changed();
    },
    failed(interactionId) {
      if (answers.get(interactionId)?.state !== "sending") return;
      answers.delete(interactionId);
      changed();
    },
    forget(interactionId) {
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
 * This device's answer to `interactionId`, if it answered the same request (`identity`); a
 * remembered answer to a different request under a reused id is ignored.
 */
export function useLocalAnswer(
  interactionId: string | undefined,
  identity?: string | undefined,
): LocalAnswer | undefined {
  const answer = useSyncExternalStore(
    answerStore.subscribe,
    () => (interactionId ? answerStore.get(interactionId) : undefined),
    () => undefined,
  );
  if (!answer) return undefined;
  if (answer.state === "sent" && answer.identity !== identity) return undefined;
  return answer;
}
