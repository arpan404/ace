import { spadeMarkup, type SpadeInline } from "@ace/ui-core/spade-chat";
import { useSyncExternalStore } from "react";

/*
 * Read aloud (ADR 0134): a bot's reply spoken by the system's own voice (`speechSynthesis`).
 * One reply speaks at a time; reading another stops the first. Spade takes no part.
 */

let speaking: string | undefined;
const listeners = new Set<() => void>();

function set(key: string | undefined) {
  speaking = key;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The system can speak. */
export function canReadAloud(): boolean {
  return typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance === "function";
}

const inlineText = (inlines: readonly SpadeInline[]) =>
  inlines.map((inline) => inline.text).join("");

/** A reply's words as they are said: its formatting marks left out, code as written. */
export function spokenText(text: string): string {
  return spadeMarkup(text)
    .map((block) =>
      block.kind === "code"
        ? block.text
        : block.kind === "list"
          ? block.items.map(inlineText).join("\n")
          : inlineText(block.inlines),
    )
    .join("\n\n");
}

/** Speak `text` as the reply `key`, stopping whatever else was being read. */
export function readAloud(key: string, text: string) {
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(spokenText(text));
  const done = () => {
    if (speaking === key) set(undefined);
  };
  utterance.addEventListener("end", done);
  utterance.addEventListener("error", done);
  set(key);
  speechSynthesis.speak(utterance);
}

export function stopReading() {
  set(undefined);
  if (canReadAloud()) speechSynthesis.cancel();
}

/** Stop reading if the reply `key` is what is being read (its bubble is going away). */
export function stopReadingOf(key: string) {
  if (speaking === key) stopReading();
}

/** Whether the reply `key` is being read now. */
export function useReading(key: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => speaking === key,
    () => false,
  );
}
