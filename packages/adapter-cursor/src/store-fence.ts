import { sessionStoreUnusable } from "@ace/provider-kit/open-error";

/*
 * Which Cursor failures mean the thread's saved SDK session can never be opened again, so ace
 * continues in a fresh session instead of retrying (ADR 0211). The adapter's own guards say so
 * in words only ("…; use context handoff", a fenced journal, a store over its budget), and those
 * words can arrive wrapped: in a host request's rejection or as the cause of a failed history
 * check. Unsafe files (a symlink where a store should be) are never handed off: a fresh folder
 * beside them would not be safer. Pure.
 */

const unusable = [
  /\buse (?:explicit |bounded )?(?:portable )?context handoff\b/i,
  /\bSDK journal is fenced\b/i,
  /\bSDK (?:JSONL |aggregate )?checkpoint (?:growth |reservation backlog |blob |inventory )?exceeds\b/i,
  /\bSDK checkpoint (?:writes are|quota is) fenced\b/i,
  /\bSDK (?:recovery run|durable event) inventory exceeds budget\b/i,
  /\bSDK recovery metadata (?:bytes )?exceeds? budget\b/i,
  /\bSDK observe identity budget exceeded\b/i,
  /\bSDK translation provenance is fenced\b/i,
];
const unsafe = /\bUnsafe SDK checkpoint\b|\bsymlink\b/i;

function messages(error: unknown): string[] {
  const found: string[] = [];
  let current: unknown = error;
  // Bounded: a cause chain is short, and a cyclic one must not hang the classifier.
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth++) {
    if (typeof current === "string") {
      found.push(current);
      break;
    }
    if (typeof current !== "object") break;
    const message: unknown = Reflect.get(current, "message");
    if (typeof message === "string") found.push(message);
    current = Reflect.get(current, "cause");
  }
  return found;
}

/** True when `error` says this thread's saved Cursor session can never be opened again. */
export function cursorStoreUnusable(error: unknown): boolean {
  const said = messages(error);
  if (said.some((message) => unsafe.test(message))) return false;
  return said.some((message) => unusable.some((pattern) => pattern.test(message)));
}

/** `error`, carrying the engine's unusable-store code when it is one; otherwise unchanged. */
export function markStoreUnusable(error: unknown): unknown {
  if (!cursorStoreUnusable(error)) return error;
  const message = messages(error)[0] ?? "Cursor's saved session can't be opened";
  return Object.assign(new Error(message, { cause: error }), { code: sessionStoreUnusable });
}
