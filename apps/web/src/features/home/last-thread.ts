import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { z } from "zod";

/**
 * The thread last open in Home, so coming back to Home lands on it instead of an empty pane.
 * Kept on this device only.
 */
const key = "ace.home.lastThread";
const LastThread = z.string().min(1).nullable();

export function lastThread(storage: KeyValueStorage | undefined): string | null {
  return readJson(storage, key, LastThread, null);
}

export function rememberThread(storage: KeyValueStorage | undefined, threadId: string): void {
  if (lastThread(storage) !== threadId) writeJson(storage, key, threadId);
}
