import { expect, test } from "vitest";
import { LocalStore } from "../store.ts";
import { type DiffPrefs, type ViewedFiles } from "../services.ts";
import type { ReviewDraft } from "./drafts.ts";
import { discardDraft, saveDraft } from "./drafts.ts";
import { persistReview } from "./review-store.ts";

function memory() {
  const data = new Map<string, string>();
  const listeners: (() => void)[] = [];
  return {
    tab: () => ({
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size;
      },
    }),
    subscribe: (changed: () => void) => {
      listeners.push(changed);
    },
    notify: () => {
      for (const changed of listeners) changed();
    },
  };
}
async function device(shared: ReturnType<typeof memory>) {
  const services = {
    drafts: new LocalStore<readonly ReviewDraft[]>([]),
    diffPrefs: new LocalStore<DiffPrefs>({ mode: "auto", wrap: false, tree: true }),
    viewed: new LocalStore<ViewedFiles>(new Map()),
  };
  persistReview(services, shared.tab(), shared.subscribe);
  return services;
}
const draft = (file: string, text: string) => ({
  threadId: "thread",
  file,
  side: "new" as const,
  line: 1,
  text,
  createdAt: 1,
});

test("saving in another initialized tab preserves both unsent comments on reload", async () => {
  const storage = memory();
  const a = await device(storage);
  const b = await device(storage);
  saveDraft(a.drafts, draft("a.ts", "Review A"));
  saveDraft(b.drafts, draft("b.ts", "Review B"));
  const reload = await device(storage);
  expect(
    reload.drafts
      .get()
      .map((entry) => entry.text)
      .toSorted(),
  ).toEqual(["Review A", "Review B"]);
  storage.notify();
  expect(
    a.drafts
      .get()
      .map((entry) => entry.text)
      .toSorted(),
  ).toEqual(["Review A", "Review B"]);
});

test("a stale tab cannot resurrect a deleted comment or erase an unrelated addition", async () => {
  const storage = memory();
  const a = await device(storage);
  saveDraft(a.drafts, draft("a.ts", "Review A"));
  const b = await device(storage);
  const stale = b.drafts.get();
  discardDraft(a.drafts, a.drafts.get()[0]?.key ?? "");
  saveDraft(a.drafts, draft("new.ts", "Unrelated"));
  b.drafts.set(() => stale.map((entry) => Object.assign({}, entry, { text: "Stale edit" })));
  const reload = await device(storage);
  expect(reload.drafts.get().map((entry) => entry.text)).toEqual(["Unrelated"]);
});

test("independent comments on the same line survive concurrent storage writes", async () => {
  const storage = memory();
  const a = await device(storage);
  const b = await device(storage);
  saveDraft(a.drafts, { ...draft("same.ts", "First finding"), key: "first" });
  saveDraft(b.drafts, { ...draft("same.ts", "Second finding"), key: "second" });
  storage.notify();
  saveDraft(a.drafts, { ...draft("same.ts", "Edited first finding"), key: "first" });
  expect(
    (await device(storage)).drafts
      .get()
      .map((entry) => entry.text)
      .toSorted(),
  ).toEqual(["Edited first finding", "Second finding"]);
});

test("legacy drafts retain retry identities and settle interrupted operations on reload", async () => {
  const storage = memory();
  storage.tab().setItem(
    "ace.review.drafts",
    JSON.stringify([
      {
        ...draft("a.ts", "Retry me"),
        key: "sending",
        state: "sending",
        commentId: "comment-a",
        sessionId: "session",
      },
      {
        ...draft("b.ts", "Resolve me"),
        key: "resolving",
        state: "resolving",
        commentId: "comment-b",
        sessionId: "session",
      },
    ]),
  );
  const reloaded = await device(storage);
  expect(reloaded.drafts.get()).toEqual([
    expect.objectContaining({
      text: "Retry me",
      state: "failed",
      commentId: "comment-a",
      sessionId: "session",
    }),
    expect.objectContaining({
      text: "Resolve me",
      state: "sent",
      commentId: "comment-b",
      sessionId: "session",
    }),
  ]);
  discardDraft(reloaded.drafts, "sending");
  saveDraft(reloaded.drafts, { ...draft("a.ts", "Fresh comment"), key: "fresh" });
  expect(
    (await device(storage)).drafts
      .get()
      .map((entry) => entry.text)
      .toSorted(),
  ).toEqual(["Fresh comment", "Resolve me"]);
});

test("a denied storage write preserves the comment for the current page", () => {
  const services = {
    drafts: new LocalStore<readonly ReviewDraft[]>([]),
    diffPrefs: new LocalStore<DiffPrefs>({ mode: "auto", wrap: false, tree: true }),
    viewed: new LocalStore<ViewedFiles>(new Map()),
  };
  persistReview(services, {
    getItem: () => null,
    setItem: () => {
      throw new Error("Storage full");
    },
  });
  saveDraft(services.drafts, draft("a.ts", "Keep my work"));
  expect(services.drafts.get()).toEqual([
    expect.objectContaining({ text: "Keep my work", state: "draft" }),
  ]);
});
