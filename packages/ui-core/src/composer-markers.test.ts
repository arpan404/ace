import { describe, expect, test } from "vitest";
import {
  attachmentMarker as M,
  insertAttachmentMarkers,
  linkAttachmentMarkers,
  placeAttachmentMarkers,
  pruneAttachmentMarkers,
  shiftAttachmentOffsets,
  takeAttachmentMarkers,
  withMarkerHashes,
  withoutMarkerCharacters,
} from "./composer-markers.ts";
import type { ComposerToken } from "./composer-tokens.ts";

const file = (start: number, path: string): ComposerToken => ({
  start,
  end: start + path.length + 1,
  label: `@${path}`,
  file: { path },
});
const pick = (start: number, name: string): ComposerToken => ({
  start,
  end: start + name.length,
  label: name,
  catalog: { type: "mention", entryId: "e", name, kind: "skill", arguments: "" },
});

describe("adding files", () => {
  test("puts each file's marker at the caret, in order, moving later chips along", () => {
    const after = insertAttachmentMarkers("see @a.ts here", [file(4, "a.ts")], 0, [
      { key: 1, name: "one.png" },
      { key: 2, name: "two.pdf" },
    ]);
    expect(after.text).toBe(`${M}${M}see @a.ts here`);
    expect(after.caret).toBe(2);
    expect(after.tokens.map((token) => [token.label, token.start])).toEqual([
      ["one.png", 0],
      ["two.pdf", 1],
      ["@a.ts", 6],
    ]);
  });

  test("a paste can't bring in a marker of its own", () => {
    expect(withoutMarkerCharacters(`a${M}b`)).toBe("ab");
  });
});

describe("sending", () => {
  test("takes the markers out and says where each file was, in text-part offsets", () => {
    const marked = insertAttachmentMarkers("look at  and /review it", [pick(13, "/review")], 8, [
      { key: 1, name: "shot.png" },
    ]);
    const end = insertAttachmentMarkers(marked.text, marked.tokens, marked.text.length, [
      { key: 2, name: "log.txt" },
    ]);
    const sent = takeAttachmentMarkers(
      end.text,
      withMarkerHashes(end.tokens, [{ key: 1, sha256: "s1" }]),
    );
    expect(sent.text).toBe("look at  and /review it");
    expect(sent.tokens).toEqual([pick(13, "/review")]);
    // "/review" goes as its own part, so the file after it counts only the text around it.
    expect(sent.files).toEqual([
      { key: 1, sha256: "s1", at: 8 },
      { key: 2, sha256: undefined, at: 16 },
    ]);
  });

  test("a file back in a returned message stands where it was sent", () => {
    const text = "look at  and /review it";
    const placed = placeAttachmentMarkers(
      text,
      [pick(13, "/review")],
      [
        { sha256: "s2", at: 16, name: "log.txt" },
        { sha256: "s1", at: 8, name: "shot.png" },
        { sha256: "s3", name: "old.txt" },
      ],
    );
    expect(placed.text).toBe(`look at ${M} and /review it${M}`);
    expect(placed.tokens.map((token) => [token.label, token.start])).toEqual([
      ["shot.png", 8],
      ["/review", 14],
      ["log.txt", 24],
    ]);
    expect(takeAttachmentMarkers(placed.text, placed.tokens).files.map((f) => f.at)).toEqual([
      8, 16,
    ]);
  });
});

describe("keeping markers tied to their files", () => {
  const draft = insertAttachmentMarkers("a b", [], 1, [
    { key: 1, name: "one.png" },
    { key: 2, name: "two.png" },
  ]);

  test("a removed file's marker goes, the rest stay", () => {
    const pruned = pruneAttachmentMarkers(draft.text, draft.tokens, new Set([2]));
    expect(pruned.text).toBe(`a${M} b`);
    expect(pruned.tokens).toEqual([{ start: 1, end: 2, label: "two.png", attachment: { key: 2 } }]);
  });

  test("nothing changes while every file is attached", () => {
    const kept = pruneAttachmentMarkers(draft.text, draft.tokens, new Set([1, 2]));
    expect(kept.tokens).toBe(draft.tokens);
  });

  test("a restored draft's markers find their files by hash; one without a held file goes", () => {
    const stored = withMarkerHashes(draft.tokens, [{ key: 2, sha256: "s2" }]);
    const linked = linkAttachmentMarkers(draft.text, stored, [
      { key: -1, sha256: "s2" },
      { key: -2, sha256: "s9" },
    ]);
    expect(linked.text).toBe(`a${M} b`);
    expect(linked.tokens).toEqual([
      { start: 1, end: 2, label: "two.png", attachment: { key: -1, sha256: "s2" } },
    ]);
  });
});

describe("editing a queued message's words", () => {
  const text = (value: string) => [{ type: "text" as const, text: value }];
  test.each([
    ["moves a file after the edit", "ab cd", "ab XX cd", 4, 7],
    ["keeps a file before the edit", "ab cd", "ab cdXX", 2, 2],
    ["keeps a file right where words are added", "ab cd", "abXX cd", 2, 2],
    ["moves a file inside deleted words to where they were", "ab cd ef", "ab ef", 4, 3],
  ])("%s", (_name, before, after, at, moved) => {
    expect(shiftAttachmentOffsets(text(before), text(after), [{ sha256: "s", at }])).toEqual([
      { sha256: "s", at: moved },
    ]);
  });
});
