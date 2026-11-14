import { draftLimits, type ComposerDraft } from "@ace/ui-core";
import { expect, test } from "vitest";
import { memoryKeyValue } from "@/test/harness.tsx";
import { draftStorageKey, readDraft, writeDraft } from "./draft-store.ts";

const draft = (text: string): ComposerDraft => ({ text, mentions: [], attachments: [] });
const legacy = (entries: [string, ComposerDraft][]) => {
  const storage = memoryKeyValue();
  storage.setItem("ace.composer.drafts", JSON.stringify(entries));
  return storage;
};
/** Records the keys each write touches, refusing those `refuse` names. */
function watched(storage: ReturnType<typeof memoryKeyValue>, refuse?: (key: string) => boolean) {
  const written: string[] = [];
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (refuse?.(key)) throw new Error("QuotaExceededError");
    written.push(key);
    setItem(key, value);
  };
  return written;
}

test("drafts saved under the old single key are still there after it is split", () => {
  const storage = legacy([
    ["thread:a", draft("First thought")],
    ["new:[relay]", draft("A preparation")],
  ]);
  expect(readDraft(storage, "thread:a")?.text).toBe("First thought");
  expect(readDraft(storage, "new:[relay]")?.text).toBe("A preparation");
  expect(storage.getItem("ace.composer.drafts")).toBeNull();
  // Each now has a key of its own, and keeps it across a reload of the page.
  expect(storage.getItem(draftStorageKey("thread:a"))).toContain("First thought");
});

test("saving one draft writes neither another draft nor the old list", () => {
  const storage = legacy([["thread:b", draft("Untouched")]]);
  writeDraft(storage, "thread:a", draft("Mine"));
  const before = storage.getItem(draftStorageKey("thread:b"));
  const written = watched(storage);
  writeDraft(storage, "thread:a", draft("Mine, edited"));
  expect(written).not.toContain(draftStorageKey("thread:b"));
  expect(written).not.toContain("ace.composer.drafts");
  expect(storage.getItem(draftStorageKey("thread:b"))).toBe(before);
  expect(readDraft(storage, "thread:a")?.text).toBe("Mine, edited");
});

test("a split refused for space keeps the old list, reads from it, and never revives a discarded draft", () => {
  const storage = legacy([
    ["thread:a", draft("Kept in the old list")],
    ["thread:b", draft("Discard me")],
  ]);
  watched(storage, (key) => key.startsWith("ace.composer.drafts:"));
  expect(readDraft(storage, "thread:a")?.text).toBe("Kept in the old list");
  expect(storage.getItem("ace.composer.drafts")).toContain("Kept in the old list");

  expect(writeDraft(storage, "thread:b", undefined)).toBe(true);
  expect(readDraft(storage, "thread:b")).toBeUndefined();
  expect(storage.getItem("ace.composer.drafts")).not.toContain("Discard me");
});

test("past the device's limit the oldest thread draft's key is removed", () => {
  const storage = memoryKeyValue();
  for (let n = 0; n <= draftLimits.drafts; n++) writeDraft(storage, `thread:${n}`, draft(`${n}`));
  expect(storage.getItem(draftStorageKey("thread:0"))).toBeNull();
  expect(readDraft(storage, "thread:0")).toBeUndefined();
  expect(readDraft(storage, `thread:${draftLimits.drafts}`)?.text).toBe(`${draftLimits.drafts}`);
});
