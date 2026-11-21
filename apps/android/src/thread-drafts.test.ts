import { expect, it } from "vitest";
import {
  applyDraftSave,
  draftKey,
  parseDraftEntries,
  threadDraftCharacters,
  threadDraftLimit,
  ThreadDraftStore,
  truncateDraftText,
  type ThreadDraftPersistence,
} from "./thread-drafts.ts";

function memoryPersistence(json: string | null = null): ThreadDraftPersistence & {
  json: string | null;
  writes: string[];
} {
  return {
    json,
    writes: [],
    async load() {
      return this.json;
    },
    async save(value: string) {
      this.writes.push(value);
      this.json = value;
    },
  };
}

it("keeps iOS limits: 50 drafts, 100,000 characters each", () => {
  expect(threadDraftLimit).toBe(50);
  expect(threadDraftCharacters).toBe(100_000);
});

it("scopes a draft to one machine and thread", async () => {
  const persist = memoryPersistence();
  const drafts = new ThreadDraftStore(persist);
  await drafts.open();
  await drafts.save("half a thought", draftKey("host", "thread-a"));
  expect(drafts.textFor(draftKey("host", "thread-a"))).toBe("half a thought");
  expect(drafts.textFor(draftKey("host", "thread-b"))).toBe("");
  expect(drafts.textFor(draftKey("other-host", "thread-a"))).toBe("");
});

it("typed words come back after a relaunch", async () => {
  const persist = memoryPersistence();
  const typing = new ThreadDraftStore(persist);
  await typing.open();
  await typing.save("half a thought", draftKey("host", "thread-a"));
  const reopened = new ThreadDraftStore(persist);
  await reopened.open();
  expect(reopened.textFor(draftKey("host", "thread-a"))).toBe("half a thought");
  expect(reopened.textFor(draftKey("host", "thread-b"))).toBe("");
});

it("words that are only whitespace remove the draft", async () => {
  const persist = memoryPersistence();
  const drafts = new ThreadDraftStore(persist);
  await drafts.open();
  await drafts.save("half a thought", draftKey("host", "thread"));
  await drafts.save("   \n  ", draftKey("host", "thread"));
  expect(drafts.textFor(draftKey("host", "thread"))).toBe("");
  const reopened = new ThreadDraftStore(persist);
  await reopened.open();
  expect(reopened.textFor(draftKey("host", "thread"))).toBe("");
});

it("truncates one draft to 100,000 characters", async () => {
  const persist = memoryPersistence();
  const drafts = new ThreadDraftStore(persist);
  await drafts.open();
  await drafts.save("x".repeat(threadDraftCharacters + 500), draftKey("host", "thread"));
  expect(drafts.textFor(draftKey("host", "thread"))).toBe("x".repeat(threadDraftCharacters));
});

it("lets the oldest drafts fall off past the limit", async () => {
  const persist = memoryPersistence();
  const drafts = new ThreadDraftStore(persist);
  await drafts.open();
  for (let index = 0; index <= threadDraftLimit; index++)
    await drafts.save(`words ${index}`, `key-${index}`);
  expect(drafts.textFor("key-0")).toBe("");
  expect(drafts.textFor("key-1")).toBe("words 1");
  expect(drafts.textFor(`key-${threadDraftLimit}`)).toBe(`words ${threadDraftLimit}`);
  const reread = new ThreadDraftStore(persist);
  await reread.open();
  expect(reread.textFor("key-0")).toBe("");
  expect(reread.textFor(`key-${threadDraftLimit}`)).toBe(`words ${threadDraftLimit}`);
});

it("rewriting a draft makes it the newest", () => {
  const entries = applyDraftSave(
    applyDraftSave(applyDraftSave([], "a", "first"), "b", "second"),
    "a",
    "first again",
  );
  expect(entries.map(([key]) => key)).toEqual(["b", "a"]);
  expect(entries.map(([, text]) => text)).toEqual(["second", "first again"]);
});

it("reads corrupt storage as no drafts and repairs it on the next save", async () => {
  const persist = memoryPersistence("not json{{{");
  const drafts = new ThreadDraftStore(persist);
  await drafts.open();
  expect(drafts.textFor(draftKey("host", "thread"))).toBe("");
  await drafts.save("kept", draftKey("host", "thread"));
  expect(drafts.textFor(draftKey("host", "thread"))).toBe("kept");
  expect(() => parseDraftEntries(persist.json)).not.toThrow();
});

it("keeps words in memory when the disk write fails, then persists them", async () => {
  let fail = true;
  const backing = memoryPersistence();
  const persist: ThreadDraftPersistence = {
    load: () => backing.load(),
    async save(value) {
      if (fail) throw new Error("Disk full");
      await backing.save(value);
    },
  };
  const drafts = new ThreadDraftStore(persist);
  await drafts.open();
  await drafts.save("unsent words", draftKey("host", "thread"));
  expect(drafts.textFor(draftKey("host", "thread"))).toBe("unsent words");
  fail = false;
  await drafts.save("unsent words, edited", draftKey("host", "thread"));
  const reopened = new ThreadDraftStore(backing);
  await reopened.open();
  expect(reopened.textFor(draftKey("host", "thread"))).toBe("unsent words, edited");
});

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

it("truncates by code point so emoji survive the limit", async () => {
  const persist = memoryPersistence();
  const drafts = new ThreadDraftStore(persist);
  await drafts.open();
  // "a😀" repeats land the cut inside a surrogate pair under UTF-16 slicing.
  await drafts.save("a😀".repeat(threadDraftCharacters), draftKey("host", "thread"));
  const kept = drafts.textFor(draftKey("host", "thread"));
  expect(Array.from(kept)).toHaveLength(threadDraftCharacters);
  expect(loneSurrogate.test(kept)).toBe(false);
  expect(kept).toBe(truncateDraftText("a😀".repeat(threadDraftCharacters)));
});

it("leaves short emoji drafts untouched", () => {
  const text = "half a thought 😀👍";
  expect(truncateDraftText(text)).toBe(text);
});

it("a failed load reads as no drafts instead of throwing", async () => {
  const persist: ThreadDraftPersistence = {
    load: async () => {
      throw new Error("database locked");
    },
    save: async () => {},
  };
  const drafts = new ThreadDraftStore(persist);
  await drafts.open();
  expect(drafts.textFor(draftKey("host", "thread"))).toBe("");
  await drafts.save("kept", draftKey("host", "thread"));
  expect(drafts.textFor(draftKey("host", "thread"))).toBe("kept");
});

it("a slow disk still round-trips through close and reopen", async () => {
  const backing = memoryPersistence();
  const slow: ThreadDraftPersistence = {
    load: () => backing.load(),
    async save(value: string) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await backing.save(value);
    },
  };
  const typing = new ThreadDraftStore(slow);
  await typing.open();
  await typing.save("half a thought", draftKey("host", "thread-a"));
  await typing.settled();
  const reopened = new ThreadDraftStore(backing);
  await reopened.open();
  expect(reopened.textFor(draftKey("host", "thread-a"))).toBe("half a thought");
});
