import { contentHash, LruCache } from "@ace/ui-core";
import { offThread } from "@/lib/off-thread.ts";
import { markdownDoc, type MarkdownBlock, type MarkdownDoc } from "./blocks.ts";

/*
 * Rendered-markdown documents by content hash, computed in the markdown worker. Each mounted
 * message is a slot that shows the newest document finished for it, so a streaming message
 * keeps showing its previous text until the next one is ready (no flash of plain text), and
 * asks for at most one document at a time, always the newest text (latest wins).
 */

interface Slot {
  shown: MarkdownDoc | undefined;
  wanted: string | undefined;
  busy: boolean;
  listeners: Set<() => void>;
}

/** Documents by text hash: enough for every message a person scrolls through in a session. */
const docs = new LruCache<string, MarkdownDoc>({
  maxEntries: 400,
  maxWeight: 16 * 1024 * 1024,
  weigh: (doc) => doc.blocks.reduce((sum, block) => sum + block.token.raw.length * 3, 64),
});
/** Blocks by key, so an unchanged block keeps one object and its rendered elements. */
const blocks = new LruCache<string, MarkdownBlock>({
  maxEntries: 4_000,
  maxWeight: 16 * 1024 * 1024,
  weigh: (block) => block.token.raw.length * 3 + 64,
});

const worker = offThread<{ text: string; hash: string }, MarkdownDoc>({
  spawn: () =>
    new Worker(new URL("./markdown.worker.ts", import.meta.url), {
      type: "module",
      name: "ace-markdown",
    }),
  local: ({ text, hash }) => markdownDoc(text, hash),
  // Same-origin worker built from blocks.ts; its documents are not decoded twice.
  decode: (output) => output as MarkdownDoc,
});

/**
 * Shares blocks seen before, so they keep their rendered elements. A document already
 * superseded by newer text (a message still streaming) is shown but not cached, and its last
 * block, the one still growing, is not kept: otherwise every frame of a long answer would push
 * finished messages and blocks out of the caches.
 */
function intern(doc: MarkdownDoc, settled: boolean): MarkdownDoc {
  const last = doc.blocks.length - 1;
  const shared = doc.blocks.map((block, index) => {
    const known = blocks.get(block.key);
    if (known) return known;
    if (settled || index < last) blocks.set(block.key, block);
    return block;
  });
  const interned = { hash: doc.hash, blocks: shared };
  if (settled) docs.set(doc.hash, interned);
  return interned;
}

const slots = new Map<string, Slot>();
const slotOf = (id: string) => {
  let slot = slots.get(id);
  if (!slot) {
    slot = { shown: undefined, wanted: undefined, busy: false, listeners: new Set() };
    slots.set(id, slot);
  }
  return slot;
};

function show(slot: Slot, doc: MarkdownDoc): void {
  if (slot.shown === doc) return;
  slot.shown = doc;
  for (const listener of slot.listeners) listener();
}

function pump(slot: Slot): void {
  const text = slot.wanted;
  if (slot.busy || text === undefined) return;
  slot.wanted = undefined;
  const hash = contentHash(text);
  const cached = docs.get(hash);
  if (cached) return show(slot, cached);
  slot.busy = true;
  void worker.run({ text, hash }).then(
    (doc) => {
      slot.busy = false;
      show(slot, intern(doc, slot.wanted === undefined));
      pump(slot);
    },
    () => {
      slot.busy = false;
      pump(slot);
    },
  );
}

export const markdownService = {
  /** Whether documents are computed in a worker; otherwise `read` computes them in place. */
  parallel: worker.parallel,
  watch(slotId: string, listener: () => void): () => void {
    const slot = slotOf(slotId);
    slot.listeners.add(listener);
    return () => {
      slot.listeners.delete(listener);
      if (!slot.listeners.size) slots.delete(slotId);
    };
  },
  /** Ask for `text`'s document in this slot. */
  want(slotId: string, text: string): void {
    const slot = slotOf(slotId);
    slot.wanted = text;
    pump(slot);
  },
  /**
   * The document to show for `text` (whose hash is `hash`): its own when ready, else the
   * newest one finished for this slot. Without a worker it is computed here, in place.
   */
  read(slotId: string, text: string, hash: string): MarkdownDoc | undefined {
    const ready = docs.get(hash);
    if (ready) return ready;
    if (worker.parallel) return slots.get(slotId)?.shown;
    return intern(markdownDoc(text, hash), true);
  },
};
