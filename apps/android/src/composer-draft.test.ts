import { expect, it } from "vitest";
import { ComposerDraft, type DraftStore } from "./composer-draft.ts";
import { draftKey, ThreadDraftStore } from "./thread-drafts.ts";

function memoryStore(): DraftStore & { saved: Map<string, string> } {
  const saved = new Map<string, string>();
  return {
    saved,
    textFor(key) {
      return saved.get(key) ?? "";
    },
    save(text, key) {
      saved.set(key, text);
    },
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("keeps text edited while the original send is still saving", async () => {
  const persisted: string[] = [];
  const saved = Promise.withResolvers<void>();
  const draft = new ComposerDraft(async (text) => {
    await saved.promise;
    persisted.push(text);
  });
  draft.edit("Original instruction");
  const sending = draft.send();
  draft.edit("New instruction typed while saving");
  saved.resolve();
  await sending;
  expect(persisted).toEqual(["Original instruction"]);
  expect(draft.selection.getSnapshot().text).toBe("New instruction typed while saving");
});
it("keeps a revised draft even when it matches the submitted text", async () => {
  const saved = Promise.withResolvers<void>();
  const draft = new ComposerDraft(() => saved.promise);
  draft.edit("Original");
  const sending = draft.send();
  draft.edit("Changed");
  draft.edit("Original");
  saved.resolve();
  await sending;
  expect(draft.selection.getSnapshot().text).toBe("Original");
});
it("clears only an unedited draft after it is saved", async () => {
  const saved = Promise.withResolvers<void>();
  const draft = new ComposerDraft(() => saved.promise);
  draft.edit("Original");
  const sending = draft.send();
  expect(draft.selection.getSnapshot().text).toBe("Original");
  saved.resolve();
  await sending;
  expect(draft.selection.getSnapshot().text).toBe("");
});
it("preserves the latest text when persistence fails", async () => {
  const saved = Promise.withResolvers<void>();
  const draft = new ComposerDraft(() => saved.promise);
  draft.edit("Original");
  const sending = draft.send();
  draft.edit("New instruction");
  saved.reject(new Error("Disk full"));
  await expect(sending).rejects.toThrow("Disk full");
  expect(draft.selection.getSnapshot().text).toBe("New instruction");
});
it("shows the followed thread's saved words and saves the thread left behind", () => {
  const store = memoryStore();
  store.saved.set("host thread-a", "half a thought");
  const draft = new ComposerDraft(async () => {});
  draft.follow("host thread-a", store);
  expect(draft.selection.getSnapshot().text).toBe("half a thought");
  draft.edit("half a thought, continued");
  draft.flush();
  draft.follow("host thread-b", store);
  expect(store.saved.get("host thread-a")).toBe("half a thought, continued");
  expect(draft.selection.getSnapshot().text).toBe("");
});
it("saves typing once it pauses without leaving", async () => {
  const store = memoryStore();
  const draft = new ComposerDraft(async () => {}, { saveDelayMs: 10 });
  draft.follow("host thread", store);
  draft.edit("kept while typing");
  expect(store.saved.get("host thread")).toBeUndefined();
  await pause(50);
  expect(store.saved.get("host thread")).toBe("kept while typing");
});
it("emptied words remove the draft at once", async () => {
  let json: string | null = null;
  const store = new ThreadDraftStore({
    load: async () => json,
    save: async (value) => {
      json = value;
    },
  });
  await store.open();
  const key = draftKey("host", "thread");
  const draft = new ComposerDraft(async () => {}, { saveDelayMs: 60_000 });
  draft.follow(key, store);
  draft.edit("half a thought");
  draft.flush();
  await store.settled();
  expect(store.textFor(key)).toBe("half a thought");
  draft.edit("   ");
  expect(store.textFor(key)).toBe("");
  await store.settled();
  const reopened = new ThreadDraftStore({ load: async () => json, save: async () => {} });
  await reopened.open();
  expect(reopened.textFor(key)).toBe("");
});
it("a sent message leaves no draft to send again without waiting", async () => {
  const store = memoryStore();
  const draft = new ComposerDraft(async () => {}, { saveDelayMs: 60_000 });
  draft.follow("host thread", store);
  draft.edit("ship it");
  await draft.send();
  expect(draft.selection.getSnapshot().text).toBe("");
  expect(store.saved.get("host thread")).toBe("");
});
it("a refused send keeps its draft durably", async () => {
  const store = memoryStore();
  const draft = new ComposerDraft(
    async () => {
      throw new Error("offline");
    },
    { saveDelayMs: 60_000 },
  );
  draft.follow("host thread", store);
  draft.edit("ship it");
  await expect(draft.send()).rejects.toThrow("offline");
  expect(draft.selection.getSnapshot().text).toBe("ship it");
  expect(store.saved.get("host thread")).toBe("ship it");
});
it("keeps words on screen when the draft write fails", async () => {
  const store = memoryStore();
  const failing: DraftStore = {
    textFor: (key) => store.textFor(key),
    save: () => {
      throw new Error("Disk full");
    },
  };
  const draft = new ComposerDraft(async () => {}, { saveDelayMs: 10 });
  draft.follow("host thread", failing);
  draft.edit("unsent words");
  draft.flush();
  await pause(30);
  expect(draft.selection.getSnapshot().text).toBe("unsent words");
  await draft.send();
  expect(draft.selection.getSnapshot().text).toBe("");
});
it("stays memory-only without a store", () => {
  const draft = new ComposerDraft(async () => {});
  draft.follow(null, null);
  draft.edit("ephemeral");
  draft.flush();
  expect(draft.selection.getSnapshot().text).toBe("ephemeral");
});

it("typing survives a relaunch after a background flush", async () => {
  let json: string | null = null;
  const backing = new ThreadDraftStore({
    load: async () => json,
    save: async (value) => {
      json = value;
    },
  });
  await backing.open();
  const key = draftKey("host", "thread");
  const draft = new ComposerDraft(async () => {}, { saveDelayMs: 60_000 });
  draft.follow(key, backing);
  draft.edit("half a thought");
  // Backgrounding flushes without waiting for the typing pause.
  await draft.flushAsync();
  await backing.settled();
  const reopened = new ThreadDraftStore({
    load: async () => json,
    save: async () => {},
  });
  await reopened.open();
  expect(reopened.textFor(key)).toBe("half a thought");
});

it("a refused send survives a relaunch", async () => {
  let json: string | null = null;
  const backing = new ThreadDraftStore({
    load: async () => json,
    save: async (value) => {
      json = value;
    },
  });
  await backing.open();
  const key = draftKey("host", "thread");
  const draft = new ComposerDraft(
    async () => {
      throw new Error("offline");
    },
    { saveDelayMs: 60_000 },
  );
  draft.follow(key, backing);
  draft.edit("ship it");
  await expect(draft.send()).rejects.toThrow("offline");
  await backing.settled();
  const reopened = new ThreadDraftStore({
    load: async () => json,
    save: async () => {},
  });
  await reopened.open();
  expect(reopened.textFor(key)).toBe("ship it");
});
