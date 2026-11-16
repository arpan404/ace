import { expect, test } from "vitest";
import { InteractionReads, interactionReadChars, type RequestPage } from "./interaction-reads.ts";

/** Stored requests by id, and a write count that moves whenever one is written. */
function storage(requests: Record<string, { text: string; summary?: boolean }>) {
  let writes = 0;
  return {
    write(id: string, text: string) {
      requests[id] = { text };
      writes++;
    },
    reads: new InteractionReads({
      writes: () => writes,
      request: (_thread, id) => {
        const stored = requests[id];
        return stored && { text: stored.text, summary: stored.summary === true };
      },
    }),
  };
}

function readAll(reads: InteractionReads, id: string) {
  const pages: RequestPage[] = [];
  let offset = 0;
  for (;;) {
    const page = reads.read("t", id, offset);
    if (typeof page === "string") throw new Error(page);
    pages.push(page);
    if (page.eof) return pages;
    offset = page.nextOffset;
  }
}

test("pages join into the stored request and never end inside a two-unit character", () => {
  // An emoji straddles every page boundary a plain cut would make.
  const text = `"${"a".repeat(interactionReadChars - 2)}${"😀".repeat(interactionReadChars)}"`;
  const { reads } = storage({ big: { text } });
  const pages = readAll(reads, "big");
  expect(pages.map((page) => page.text).join("")).toBe(text);
  for (const page of pages) {
    const last = page.text.charCodeAt(page.text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  }
});

test("a request's version names its JSON: unchanged it stays, changed it moves", () => {
  const { reads, write } = storage({ big: { text: '"one"' } });
  const first = readAll(reads, "big")[0]?.version;
  write("other", '"x"');
  expect(readAll(reads, "big")[0]?.version).toBe(first);
  write("big", '"two"');
  const changed = readAll(reads, "big")[0];
  expect(changed?.version).not.toBe(first);
  expect(changed?.text).toBe('"two"');
});

test("a copy that is itself a summary, or no request, can't be read whole", () => {
  const { reads } = storage({ mirrored: { text: '"cut"', summary: true } });
  expect(reads.read("t", "mirrored", 0)).toBe("request_not_whole_here");
  expect(reads.read("t", "missing", 0)).toBe("interaction_not_found");
});

test("an offset past the end reads an empty last page", () => {
  const { reads } = storage({ small: { text: '"s"' } });
  expect(reads.read("t", "small", 99)).toMatchObject({ text: "", eof: true, nextOffset: 3 });
});
