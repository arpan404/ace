import { MessageText } from "@ace/protocol";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { z } from "zod";

/*
 * One user-intended Run now per daemon per automation, kept across reloads until the
 * daemon answers for certain. A failed or uncertain send keeps its requestId (and the
 * note the person sent with it) so an explicit Retry reuses both; a definitive answer
 * clears it. Never credentials or tokens. At capacity a new intent is refused rather
 * than evicting an unresolved one (which would duplicate the run).
 */

export const RunIntent = z.object({
  daemonKey: z.string().min(1).max(1024),
  automationId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256),
  createdAt: z.number().int().min(0),
  /** The note sent with this run, so a retry asks for the same run. */
  message: MessageText.optional(),
});
export type RunIntent = z.infer<typeof RunIntent>;

const Stored = z.array(RunIntent).max(64);
const storageKey = "ace.automation.runIntents";
export const maxRunIntents = 32;

/** The daemon identity without anything that authenticates: no userinfo, query or fragment. */
export function normalizeDaemonKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.split("#")[0]?.split("?")[0] ?? url;
  }
}

export function loadRunIntents(storage: KeyValueStorage | undefined): readonly RunIntent[] {
  return readJson(storage, storageKey, Stored, []);
}

function saveRunIntents(storage: KeyValueStorage | undefined, intents: readonly RunIntent[]): void {
  writeJson(storage, storageKey, intents);
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
 * The pending intent, or a new one that is verified in storage before returning.
 * Refuses (undefined) at capacity or when the write cannot be verified, so a retry
 * never duplicates an unresolved run and dispatch never runs without a durable key.
 */
export function ensureRunIntent(
  storage: KeyValueStorage | undefined,
  daemonKey: string,
  automationId: string,
  now: () => number,
  newId: () => string,
  message?: string | undefined,
): RunIntent | undefined {
  if (storage === undefined || storage.durable === false) return undefined;
  const existing = getRunIntent(storage, daemonKey, automationId);
  if (existing) return existing;
  if (loadRunIntents(storage).length >= maxRunIntents) return undefined;
  const intent: RunIntent = {
    daemonKey,
    automationId,
    requestId: newId(),
    createdAt: now(),
    ...(message ? { message } : {}),
  };
  saveRunIntents(storage, [intent, ...loadRunIntents(storage)]);
  const verified = getRunIntent(storage, daemonKey, automationId);
  if (verified?.requestId !== intent.requestId) return undefined;
  return verified;
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
