import { expect, test } from "vitest";
import { LocalStore } from "../store.ts";
import {
  beginComposition,
  finishComposition,
  type Compositions,
  type ReviewComposition,
} from "./compositions.ts";

const empty = () => new LocalStore<Compositions>({ entries: new Map(), active: new Map() });

function editor(id: string, text = "", suggestion?: string): ReviewComposition {
  return {
    id,
    threadId: "thread",
    file: "file.ts",
    range: { side: "new", start: 2, end: 2 },
    version: "v1",
    needsReselection: false,
    fingerprint: { before: [], lines: ["const b = 2;"], after: [] },
    source: undefined,
    text,
    suggestion,
  };
}

const ids = (store: LocalStore<Compositions>) => [...store.get().entries.keys()];

test("32 unfinished editors fill the client: a new selection is refused, and finishing one makes room", () => {
  const store = empty();
  for (let number = 1; number <= 32; number++)
    expect(beginComposition(store, editor(`e${number}`, `Keep ${number}`))).toBe(true);

  expect(beginComposition(store, editor("e33"))).toBe(false);
  // Refused: nothing written is evicted, and the editor that was open stays open.
  expect(ids(store)).toHaveLength(32);
  expect(store.get().active.get("thread")).toBe("e32");
  // An editor already held reopens even at the limit.
  expect(beginComposition(store, editor("e1", "Keep 1"))).toBe(true);
  expect(store.get().active.get("thread")).toBe("e1");

  finishComposition(store, "e1");
  expect(store.get().active.has("thread")).toBe(false);
  expect(beginComposition(store, editor("e33"))).toBe(true);
  expect(ids(store)).toHaveLength(32);
});

test("a blank editor is dropped when another selection begins; written text or a suggestion keeps it", () => {
  const store = empty();
  beginComposition(store, editor("written", "Keep the written work"));
  beginComposition(store, editor("suggested", "", "const b = 4;"));
  for (let index = 0; index < 40; index++) beginComposition(store, editor(`blank-${index}`));
  expect(ids(store)).toEqual(["written", "suggested", "blank-39"]);
  expect(store.get().active.get("thread")).toBe("blank-39");
});

test("finishing a parked editor leaves the open one active", () => {
  const store = empty();
  beginComposition(store, editor("parked", "Parked"));
  beginComposition(store, editor("open", "Open"));
  finishComposition(store, "parked");
  expect(ids(store)).toEqual(["open"]);
  expect(store.get().active.get("thread")).toBe("open");
});
