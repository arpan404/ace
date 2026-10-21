import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { z } from "zod";

/*
 * One user-intended Run now per daemon per automation, kept across reloads until the
 * daemon answers for certain. A failed or uncertain send (offline, timeout, abort)
 * keeps its requestId so an explicit Retry reuses it; a definitive answer clears it.
 * Only the idempotency key is stored, never credentials or tokens.
 */

export const RunIntent = z.object({
  daemonKey: z.string().min(1).max(1024),
  automationId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256),
  createdAt: z.number().int().min(0),
});
export type RunIntent = z.infer<typeof RunIntent>;

const Stored = z.array(RunIntent).max(64);
const storageKey = "ace.automation.runIntents";
const keep = 32;

export function loadRunIntents(storage: KeyValueStorage | undefined): readonly RunIntent[] {
  return readJson(storage, storageKey, Stored, []);
}

function saveRunIntents(storage: KeyValueStorage | undefined, intents: readonly RunIntent[]): void {
  writeJson(storage, storageKey, intents.slice(0, keep));
}

export function getRunIntent(
  storage: KeyValueStorage | undefined,
  daemonKey: string,
  automationId: string,
): RunIntent | undefined {
  return loadRunIntents(storage).find(
    (intent) => intent.daemonKey === daemonKey && intent.automationId === automationId,
  );
}

/**
 * The pending intent, or a new one that is stored before returning. The same
 * requestId is reused until cleared, so a retry never submits twice.
 */
export function ensureRunIntent(
  storage: KeyValueStorage | undefined,
  daemonKey: string,
  automationId: string,
  now: () => number,
  newId: () => string,
): RunIntent {
  const existing = getRunIntent(storage, daemonKey, automationId);
  if (existing) return existing;
  const intent: RunIntent = {
    daemonKey,
    automationId,
    requestId: newId(),
    createdAt: now(),
  };
  saveRunIntents(storage, [intent, ...loadRunIntents(storage)]);
  return intent;
}

export function clearRunIntent(
  storage: KeyValueStorage | undefined,
  daemonKey: string,
  automationId: string,
): void {
  saveRunIntents(
    storage,
    loadRunIntents(storage).filter(
      (intent) => !(intent.daemonKey === daemonKey && intent.automationId === automationId),
    ),
  );
}

/**
 * Keep the intent for another try only when the send may have reached the daemon.
 * Definitive daemon answers (ok:false, or an admitted run) clear it instead.
 */
export function shouldKeepRunIntentOnError(error: unknown): boolean {
  if (error !== null && typeof error === "object" && "name" in error) {
    const record = error as { name?: unknown; code?: unknown };
    if (record.name === "ClientError") {
      return (
        record.code === "offline" ||
        record.code === "timeout" ||
        record.code === "aborted" ||
        record.code === "not_dispatched"
      );
    }
  }
  return false;
}
