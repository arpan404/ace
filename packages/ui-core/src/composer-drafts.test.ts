import { expect, test } from "vitest";
import { findDraft, putDraft, touchRecent, type ComposerDraft } from "./composer-drafts.ts";

const draft = (text: string, extra: Partial<ComposerDraft> = {}): ComposerDraft => ({
  text,
  mentions: [],
  attachments: [],
  ...extra,
});

test("a draft is found again under its key", () => {
  const entries = putDraft([], "thread-a", draft("Check the retry path"));
  expect(findDraft(entries, "thread-a")?.text).toBe("Check the retry path");
  expect(findDraft(entries, "thread-b")).toBeUndefined();
});

test("clearing a draft removes it instead of storing an empty one", () => {
  const entries = putDraft(putDraft([], "thread-a", draft("x")), "thread-a", draft("  "));
  expect(entries).toEqual([]);
});

test("attachments alone keep a draft", () => {
  const entries = putDraft(
    [],
    "thread-a",
    draft("", { attachments: [{ sha256: "a", name: "x" }] }),
  );
  expect(findDraft(entries, "thread-a")?.attachments).toHaveLength(1);
});

test("the oldest drafts fall off past the limit; rewriting one keeps it", () => {
  let entries = putDraft([], "a", draft("first"), 2);
  entries = putDraft(entries, "b", draft("second"), 2);
  entries = putDraft(entries, "a", draft("first, edited"), 2);
  entries = putDraft(entries, "c", draft("third"), 2);
  expect(entries.map(([key]) => key)).toEqual(["a", "c"]);
});

test("a mention deleted from the text is not kept", () => {
  const entries = putDraft(
    [],
    "a",
    draft("Look at @src/app.ts", { mentions: ["src/app.ts", "src/gone.ts"] }),
  );
  expect(findDraft(entries, "a")?.mentions).toEqual(["src/app.ts"]);
});

test("recent values move to the front without repeats", () => {
  expect(touchRecent(["a", "b", "c"], "c", 3)).toEqual(["c", "a", "b"]);
  expect(touchRecent(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
});
