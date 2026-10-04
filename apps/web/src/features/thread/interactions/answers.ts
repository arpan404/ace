import type { InteractionResolution } from "@ace/protocol";
import { useSyncExternalStore } from "react";

/*
 * Answers given on this device, by interaction id.
 *
 * - While one travels to the daemon it is `sending`: the card and the step it gates show the
 *   pick at once ("Approved by you"), and revert if the daemon refuses it (IR-2, SY-9).
 * - Once the daemon accepts it, it is `sent` and remembered across reloads: a request the
 *   daemon offers again after a restart (A1/A3) still reads as answered, never as an open card.
 */

export interface LocalAnswer {
  resolution: InteractionResolution;
  state: "sending" | "sent";
  at: number;
}

const storageKey = "ace.answers.v1";
/** Enough to cover every thread's recent requests; the oldest go first. */
const remembered = 300;

const answers = new Map<string, LocalAnswer>();
const listeners = new Set<() => void>();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      const value: unknown = entry[1];
      if (typeof value !== "object" || value === null || !("resolution" in value)) continue;
      const at = "at" in value && typeof value.at === "number" ? value.at : 0;
      answers.set(entry[0], {
        resolution: value.resolution as InteractionResolution,
        state: "sent",
        at,
      });
    }
  } catch {
    /* Unreadable storage: nothing remembered. */
  }
}

function persist() {
  const sent = [...answers].filter(([, answer]) => answer.state === "sent").slice(-remembered);
  try {
    globalThis.localStorage?.setItem(
      storageKey,
      JSON.stringify(
        sent.map(([id, answer]) => [id, { resolution: answer.resolution, at: answer.at }]),
      ),
    );
  } catch {
    /* Private mode or quota: remembered for this session only. */
  }
}

function changed() {
  for (const listener of listeners) listener();
}

/** The person picked `resolution` here; it is on its way. */
export function answerSending(interactionId: string, resolution: InteractionResolution) {
  load();
  answers.delete(interactionId);
  answers.set(interactionId, { resolution, state: "sending", at: Date.now() });
  changed();
}

/** The daemon accepted the answer. */
export function answerSent(interactionId: string) {
  const answer = answers.get(interactionId);
  if (!answer) return;
  answers.set(interactionId, { ...answer, state: "sent" });
  while (answers.size > remembered) answers.delete(answers.keys().next().value!);
  persist();
  changed();
}

/** The answer didn't go through: the card offers the choice again. */
export function answerFailed(interactionId: string) {
  if (answers.get(interactionId)?.state !== "sending") return;
  answers.delete(interactionId);
  changed();
}

/** Forget a remembered answer so the request can be answered again. */
export function forgetAnswer(interactionId: string) {
  if (!answers.delete(interactionId)) return;
  persist();
  changed();
}

/** Forget every answer this device remembers (signing out, tests). */
export function forgetAllAnswers() {
  answers.clear();
  try {
    globalThis.localStorage?.removeItem(storageKey);
  } catch {
    /* Nothing stored. */
  }
  changed();
}

function subscribe(listener: () => void) {
  load();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLocalAnswer(interactionId: string | undefined): LocalAnswer | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (interactionId ? answers.get(interactionId) : undefined),
    () => undefined,
  );
}
