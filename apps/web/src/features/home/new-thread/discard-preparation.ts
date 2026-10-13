import type { KeyValueStorage } from "@ace/ui-core";
import {
  ComposerDraftSchema,
  discardDraft,
  readDraft,
  writeDraft,
} from "@/features/thread/index.ts";
import { preparation, savePreparation } from "./preparations.ts";

/** Keep a durable recovery copy through either half of a local discard failing. */
export function discardPreparation(
  storage: KeyValueStorage | undefined,
  host: string,
  key: string,
): boolean {
  const row = preparation(storage, host, key);
  if (!row) return false;
  const content = readDraft(storage, key) ?? row.discardRecovery;
  const recovery = content ? ComposerDraftSchema.parse(content) : undefined;
  if (!savePreparation(storage, host, key, { ...row, discardRecovery: recovery })) return false;
  if (!discardDraft(storage, key)) {
    // The refused discard left the content where it was: keep this page showing it too.
    writeDraft(storage, key, content);
    return false;
  }
  if (!savePreparation(storage, host, key, undefined)) {
    // Restore the usual composer key when possible. If that also fails, the row's copy survives.
    writeDraft(storage, key, content);
    return false;
  }
  return true;
}
