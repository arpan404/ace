import { describe, expect, it } from "vitest";
import { opening, type Opening, type Read } from "./opening.ts";
import type { Draft } from "./types.ts";

const disk = (text: string, version: string): Read => ({
  ok: true,
  file: { kind: "text", text, version },
});
const draft: Draft = { text: "typed\n", original: "one\n", version: "v1" };

describe("what a buffer opens as", () => {
  const table: [string, Read, Draft | undefined, Opening][] = [
    [
      "the disk text, saved, with no draft",
      disk("one\n", "v1"),
      undefined,
      { kind: "text", text: "one\n", base: { text: "one\n", version: "v1" }, dirty: false },
    ],
    [
      "the draft, unsaved, when the disk is still at its base",
      disk("one\n", "v1"),
      draft,
      {
        kind: "text",
        text: "typed\n",
        base: { text: "one\n", version: "v1" },
        dirty: true,
        dropDraft: false,
      },
    ],
    [
      "the disk text, saved, when a draft only repeats it (the draft goes)",
      disk("typed\n", "v1"),
      draft,
      {
        kind: "text",
        text: "typed\n",
        base: { text: "typed\n", version: "v1" },
        dirty: false,
        dropDraft: true,
      },
    ],
    [
      "the draft on its own base with a clash when the disk moved",
      disk("agent\n", "v2"),
      draft,
      {
        kind: "text",
        text: "typed\n",
        base: { text: "one\n", version: "v1" },
        dirty: true,
        clash: { kind: "changed", theirs: { text: "agent\n", version: "v2" } },
      },
    ],
    [
      "the draft with a deleted clash when the file is gone",
      { ok: true, file: { kind: "missing" } },
      draft,
      {
        kind: "text",
        text: "typed\n",
        base: { text: "one\n", version: "v1" },
        dirty: true,
        clash: { kind: "deleted" },
      },
    ],
    [
      "missing when the file is gone and nothing was typed",
      { ok: true, file: { kind: "missing" } },
      undefined,
      { kind: "status", status: { kind: "missing" } },
    ],
    [
      "the draft when the daemon can't be reached",
      { ok: false, message: "offline" },
      draft,
      { kind: "text", text: "typed\n", base: { text: "one\n", version: "v1" }, dirty: true },
    ],
    [
      "failed when the daemon can't be reached and there is no draft",
      { ok: false, message: "offline" },
      undefined,
      { kind: "status", status: { kind: "failed", message: "offline" } },
    ],
    [
      "unreadable for a binary file, draft or not",
      { ok: true, file: { kind: "unreadable", reason: "binary" } },
      draft,
      { kind: "status", status: { kind: "unreadable", reason: "binary" } },
    ],
  ];
  for (const [name, read, stored, expected] of table)
    it(name, () => {
      expect(opening(read, stored)).toEqual(expected);
    });
});
