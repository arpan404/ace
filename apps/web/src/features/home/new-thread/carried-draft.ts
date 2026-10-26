import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { z } from "zod";
import { discardDraft, readDraft, writeDraft } from "@/features/thread/index.ts";
import { primaryMachineId } from "@/lib/machines.ts";
import { discardPreparation } from "./discard-preparation.ts";
import { preparation } from "./preparations.ts";

/*
 * A message carried to another machine when New thread moves there. The message stays in its
 * old preparation until the other machine's composer has its own copy, so nothing is lost if
 * that machine can't take it yet (its project isn't there). Files live in the old machine's
 * draft scope and can't travel: a draft with files keeps them, and its text, where it was.
 */

const storageKey = "ace.home.newThreadCarry";
const Carry = z.object({
  /** The machine it goes to, by id (`primaryMachineId`: this window's own, while unnamed). */
  to: z.string().min(1),
  from: z.object({ host: z.string().min(1), key: z.string().min(1) }),
});
type Carry = z.infer<typeof Carry>;

const read = (storage: KeyValueStorage | undefined) =>
  readJson<Carry | undefined>(storage, storageKey, Carry, undefined);
const clear = (storage: KeyValueStorage | undefined) => {
  if (storage?.removeItem) storage.removeItem(storageKey);
  else writeJson(storage, storageKey, null);
};
const goesTo = (carry: Carry, host: string) => carry.to === host || carry.to === primaryMachineId;

/** Carry the message in `from` to machine `to`; a message with no text has nothing to carry. */
export function carryDraft(
  storage: KeyValueStorage | undefined,
  from: { host: string; key: string },
  to: string,
): void {
  if (readDraft(storage, from.key)?.text.trim()) writeJson(storage, storageKey, { to, from });
  else clear(storage);
}

/** The text on its way to machine `host`, for a page that can't take it yet. */
export function carriedText(storage: KeyValueStorage | undefined, host: string) {
  const carry = read(storage);
  return carry && goesTo(carry, host) ? readDraft(storage, carry.from.key)?.text : undefined;
}

/**
 * Move the message carried to `host` into the draft at `key`, and return its text. A draft
 * that already has text keeps it, and the carried message stays where it was.
 */
export function takeCarriedDraft(
  storage: KeyValueStorage | undefined,
  host: string,
  key: string,
): string | undefined {
  const carry = read(storage);
  if (!carry || !goesTo(carry, host) || carry.from.key === key) return undefined;
  clear(storage);
  if (readDraft(storage, key)?.text.trim()) return undefined;
  const content = readDraft(storage, carry.from.key);
  const text = content?.text;
  if (!content || !text?.trim()) return undefined;
  if (!writeDraft(storage, key, { text, mentions: [], attachments: [] })) return undefined;
  // Moved, not copied: one message, one draft row. Files keep the old draft where it was.
  if (!content.attachments.length) {
    if (preparation(storage, carry.from.host, carry.from.key))
      discardPreparation(storage, carry.from.host, carry.from.key);
    else discardDraft(storage, carry.from.key);
  }
  return text;
}
