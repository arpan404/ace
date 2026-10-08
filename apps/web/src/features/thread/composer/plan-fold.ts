import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import * as z from "zod/mini";

/*
 * Which threads have their plan raised in the composer's tab, kept on this device. A plan is
 * folded to its current step by default; raising it is remembered per thread, the most recent
 * few hundred.
 */
const key = "ace.composer.raisedPlans";
const Raised = z.catch(z.array(z.string()), []);
const kept = 200;

export function planRaised(storage: KeyValueStorage | undefined, threadId: string): boolean {
  return readJson(storage, key, Raised, []).includes(threadId);
}

export function rememberPlanRaised(
  storage: KeyValueStorage | undefined,
  threadId: string,
  raised: boolean,
): void {
  const others = readJson(storage, key, Raised, []).filter((id) => id !== threadId);
  writeJson(storage, key, raised ? [threadId, ...others].slice(0, kept) : others);
}
