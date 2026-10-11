import { Lexer, type Token } from "marked";
import { describe, expect, test, vi } from "vitest";
import { BlockStream, isContent } from "./block-stream.ts";
import { highlight } from "./highlight.ts";
import { longAnswer, markdownSamples } from "./markdown-samples.fixture.ts";
import { StreamRegistry, type StreamReply } from "./stream-registry.ts";

/** What one lex of the whole text gives, as the renderer sees it. */
const fullParse = (text: string) => Lexer.lex(text, { gfm: true, breaks: false }).filter(isContent);

/** Deterministic chunk sizes from a seed. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** Ways a provider might cut `text` into deltas. */
function chunkings(text: string): [string, string[]][] {
  const every = (size: number) => {
    const pieces: string[] = [];
    for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
    return pieces;
  };
  const ways: [string, string[]][] = [];
  if (text.length <= 4_000) ways.push(["a character at a time", every(1)]);
  for (const size of [2, 3, 7, 16, 61]) ways.push([`${size} characters at a time`, every(size)]);
  for (let seed = 1; seed <= 6; seed++) {
    const next = seeded(seed);
    const pieces: string[] = [];
    for (let at = 0; at < text.length;) {
      const size = 1 + Math.floor(next() * 48);
      pieces.push(text.slice(at, at + size));
      at += size;
    }
    ways.push([`random sizes, seed ${seed}`, pieces]);
  }
  ways.push(["a line at a time", text.split(/(?<=\n)/)]);
  return ways;
}

/** Stream `pieces`, the last one final: the settled blocks, and every update. */
function stream(pieces: readonly string[]) {
  const parser = new BlockStream();
  let settled: Token[] = [];
  const updates = pieces.map((piece, index) => {
    const update = parser.push(piece, index === pieces.length - 1);
    settled = [...settled.slice(0, update.from), ...update.settled];
    return update;
  });
  return { settled, updates };
}

const samples: Record<string, string> = { ...markdownSamples, "a long answer": longAnswer };

describe("a streamed message settles into exactly the blocks of one full parse", () => {
  for (const [name, text] of Object.entries(samples))
    test(name, () => {
      const expected = fullParse(text);
      for (const [how, pieces] of chunkings(text)) {
        expect(stream(pieces).settled, `${name}, ${how}`).toEqual(expected);
      }
    });
});

test("a block that settled while streaming is never revised: it is already the final block", () => {
  // Reference definitions arriving after their references are the exception: they re-lex the
  // settled blocks once (covered on their own below).
  const late = new Set(["references", "nestedDefinitions", "prototypeLabels"]);
  for (const [name, text] of Object.entries(samples)) {
    if (late.has(name)) continue;
    const expected = fullParse(text);
    for (const [how, pieces] of chunkings(text)) {
      let count = 0;
      for (const update of stream(pieces).updates) {
        // Nothing settled before is sent again, and what settles is already final.
        expect(update.from, `${name}, ${how}`).toBe(count);
        expect(update.settled, `${name}, ${how}`).toEqual(
          expected.slice(count, count + update.settled.length),
        );
        count += update.settled.length;
      }
    }
  }
});

test("a reference resolves in an earlier settled block once its definition arrives", () => {
  const pieces = [
    "See [the docs][docs].\n\n",
    "More text.\n\n",
    "[docs]: https://ace.dev/docs\n\nEnd",
  ];
  const { settled } = stream([...pieces.slice(0, 2), "Next paragraph.\n"]);
  // Before the definition the reference is text.
  expect(JSON.stringify(settled[0])).not.toContain("https://ace.dev/docs");
  const after = stream(pieces).settled;
  expect(after).toEqual(fullParse(pieces.join("")));
  expect(JSON.stringify(after?.[0])).toContain("https://ace.dev/docs");
});

test("a definition inside a quote, settling after its reference, resolves it", () => {
  const pieces = ["See [x][ref].\n\nOther.\n", "\n> [ref]: https://ace.dev\n"];
  const settled = stream(pieces).settled;
  expect(settled).toEqual(fullParse(pieces.join("")));
  expect(JSON.stringify(settled[0])).toContain('"href":"https://ace.dev"');
});

test("labels named like object members are defined like any other", () => {
  for (const label of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    // The reference settles (a paragraph follows it) before its definition arrives.
    const pieces = [
      `Use [${label}].\n\nNext paragraph.\n`,
      `\n[${label}]: https://ace.dev/${label}\n\nEnd.\n`,
    ];
    const settled = stream(pieces).settled;
    expect(settled, label).toEqual(fullParse(pieces.join("")));
    expect(JSON.stringify(settled[0]), label).toContain(`https://ace.dev/${label}`);
  }
});

test("an anchor left open in one paragraph keeps autolinks off in the next, as in a full parse", () => {
  const pieces = ['before <a href="https://ace.dev">text\n\nwww.ace.dev\n', "\nlast\n"];
  const settled = stream(pieces).settled;
  expect(settled).toEqual(fullParse(pieces.join("")));
  // www.ace.dev stays text: no second link inside the open anchor.
  expect(JSON.stringify(settled[1])).not.toContain('"type":"link"');
});

test("only the open block is parsed again: the open part stays small as an answer grows", () => {
  const parser = new BlockStream();
  let largest = 0;
  for (let at = 0; at < longAnswer.length; at += 20) {
    const { open } = parser.push(longAnswer.slice(at, at + 20), false);
    largest = Math.max(
      largest,
      open.reduce((sum, token) => sum + token.raw.length, 0),
    );
  }
  // The answer's largest block (a fenced function or a table) is under 600 characters.
  expect(largest).toBeLessThan(600);
  expect(longAnswer.length).toBeGreaterThan(10_000);
});

const registry = () => new StreamRegistry(() => 0);
const settledOf = (reply: StreamReply) => ("resync" in reply ? [] : reply.settled);

/** The worker's replies to `pieces` streamed into one message, the last one final. */
const replies = (pieces: readonly string[]) => {
  const streams = registry();
  let at = 0;
  return pieces.map((append, index) => {
    const reply = streams.apply({
      stream: "m",
      at,
      append,
      final: index === pieces.length - 1,
    });
    at += append.length;
    return reply;
  });
};

describe("the markdown worker's streams", () => {
  test("each finished block crosses to the page once, with its code highlighted", () => {
    const pieces = chunkings(longAnswer).find(([how]) => how === "16 characters at a time")?.[1];
    if (!pieces) throw new Error("no chunking");
    const sent = replies(pieces).flatMap(settledOf);
    expect(sent.map((block) => block.token)).toEqual(fullParse(longAnswer));
    const fence = sent.find((block) => block.token.type === "code");
    const code = fence?.token.type === "code" ? fence.token.text : "";
    expect(code).toContain("export function replay");
    expect(fence?.code).toEqual(highlight(code, "ts"));
  });

  test("a released stream is forgotten: its next append asks for the whole text", () => {
    const streams = registry();
    streams.apply({ stream: "m", at: 0, append: "Para one.\n\nPara", final: false });
    streams.release("m");
    expect(streams.apply({ stream: "m", at: 15, append: " two.", final: false })).toEqual({
      resync: true,
    });
  });

  test("a stream the worker doesn't hold, or holds at another length, is asked for whole", () => {
    const streams = registry();
    expect(streams.apply({ stream: "m", at: 5, append: "more", final: false })).toEqual({
      resync: true,
    });
    streams.apply({ stream: "m", at: 0, append: "Hello", final: false });
    expect(streams.apply({ stream: "m", at: 3, append: "lo", final: false })).toEqual({
      resync: true,
    });
    const whole = streams.apply({ stream: "m", at: 0, append: "Hello\n\nworld", final: true });
    expect("resync" in whole ? [] : whole.settled.map((block) => block.token)).toEqual(
      fullParse("Hello\n\nworld"),
    );
  });
});

test("large unfinished fences and paragraphs retain their full source and settle exactly", () => {
  for (const text of [
    "```ts\n" + "const value = 42;\n".repeat(4000) + "```\n\nAfter\n",
    "[label] " + "words ".repeat(12_000) + "\n\n[label]: https://example.com\n\n",
  ]) {
    const pieces = Array.from({ length: Math.ceil(text.length / 127) }, (_, index) =>
      text.slice(index * 127, (index + 1) * 127),
    );
    expect(stream(pieces).settled).toEqual(fullParse(text));
  }
});

test("a giant fence closes live without consuming the prose that follows", () => {
  for (const marker of ["```", "~~~~"]) {
    const parser = new BlockStream();
    const body = "const value = 42;\n".repeat(800);
    parser.push(`${marker}ts\n${body}`, false);
    // Even a closing marker split between provider deltas must be recognized before final.
    parser.push(marker.slice(0, 2), false);
    const closed = parser.push(`${marker.slice(2)}\n`, false);
    expect([...closed.settled, ...closed.open]).toEqual(
      fullParse(`${marker}ts\n${body}${marker}\n`),
    );
    const after = parser.push("\n## Explanation\nHere is the result.\n", false);
    expect([...after.settled, ...after.open]).toEqual(
      fullParse(`${marker}ts\n${body}${marker}\n\n## Explanation\nHere is the result.\n`),
    );
  }
});

test("new paragraphs and headings following giant prose are parsed while streaming", () => {
  for (const following of [
    "\n\nNext paragraph.\n",
    "\n## Explanation\nNext paragraph.\n",
    "\n\n- One\n- Two\n",
  ]) {
    const parser = new BlockStream();
    const paragraph = "words ".repeat(1800);
    parser.push(paragraph, false);
    const after = parser.push(following, false);
    expect([...after.settled, ...after.open]).toEqual(fullParse(paragraph + following));
  }
});

test("code-like content inside a giant fence does not close it prematurely", () => {
  const parser = new BlockStream();
  const source = "````ts\n" + "const value = 42;\n".repeat(800);
  parser.push(source, false);
  const more = "\n## Heading\n```\n```` trailing text\n    ````\nconst next = 1;\n";
  const after = parser.push(more, false);
  expect(after.settled).toEqual([]);
  expect(after.open).toHaveLength(1);
  expect(after.open[0]?.type).toBe("code");
  expect(after.open[0]).toHaveProperty("text", (source + more).slice("````ts\n".length));
});

test("a giant fence's EOF closing candidate is exact live and remains revisable", () => {
  const parser = new BlockStream();
  const body = "const value = 42;\n".repeat(800);
  const start = "```ts\n" + body;
  parser.push(start, false);
  const closed = parser.push("```", false);
  expect(closed.settled).toEqual([]);
  expect(closed.open).toEqual(fullParse(start + "```"));
  const padding = parser.push("   ", false);
  expect(padding.open).toEqual(fullParse(start + "```   "));
  const reopened = parser.push("still code\n", false);
  expect(reopened.settled).toEqual([]);
  expect(reopened.open).toEqual(fullParse(start + "```   still code\n"));
  expect(parser.push("```\n\nDone.\n", true).settled).toEqual(
    fullParse(start + "```   still code\n```\n\nDone.\n"),
  );
});

test("an invalid backtick fence opening stays prose while its giant tail streams", () => {
  const parser = new BlockStream();
  const start = "```some`thing\n" + "words ".repeat(1800);
  parser.push(start, false);
  const next = parser.push("more words", false);
  expect(next.settled).toEqual([]);
  expect(next.open[0]?.type).toBe("paragraph");
  expect(next.open[0]?.raw).toBe(start + "more words");
  expect(parser.push("", true).settled).toEqual(fullParse(start + "more words"));
});

test("giant indented fences dedent live across partial lines and settle with exact whitespace", () => {
  for (const indent of [" ", "  ", "   "]) {
    const parser = new BlockStream();
    const start = indent + "```ts\n" + `${indent}const value = 42;\n`.repeat(800) + "tail";
    parser.push(start, false);
    let source = start;
    for (const append of ["\n ", " \t", "next", "\n\t", "value", "\n  ", "  deep", "\n", "plain"]) {
      source += append;
      const live = parser.push(append, false);
      expect(live.settled).toEqual([]);
      expect(live.open[0]?.raw).toBe(source);
      const body = live.open[0];
      const expected = fullParse(source)[0];
      if (body?.type !== "code" || expected?.type !== "code")
        throw new Error("Expected an open fenced code block");
      expect(body.text).toBe(expected.text);
    }
    const close = `\n${indent}\`\`\`\n\nDone.\n`;
    expect(parser.push(close, true).settled).toEqual(fullParse(source + close));
  }
});

test("a huge unfinished table stays readable with bounded parser work and settles before following prose", () => {
  const table =
    "| Name | Value |\n| --- | --- |\n" + "| repeated item | **value** |\n".repeat(6000);
  const parser = new BlockStream();
  let source = "";
  let examined = 0;
  const parse = Lexer.prototype.blockTokens;
  // Count characters reaching the real parser boundary, including its nested calls. This
  // guards total work rather than a particular caching implementation or wall-clock speed.
  const probe = vi.spyOn(Lexer.prototype, "blockTokens").mockImplementation(function (
    this: Lexer,
    ...args
  ) {
    examined += args[0].length;
    return parse.apply(this, args);
  });
  try {
    for (let at = 0; at < table.length; at += 127) {
      const append = table.slice(at, at + 127);
      source += append;
      const live = parser.push(append, false);
      expect(live.settled).toEqual([]);
      expect(live.open[0]?.raw).toBe(source);
      if (source.length > 8192) {
        expect(live.open[0]?.type).toBe("paragraph");
        expect(live.open[0]).toHaveProperty("text", source);
      }
    }
    const following = "\n## Explanation\nThe table is complete.\n";
    const after = parser.push(following, false);
    expect(after.settled[0]?.type).toBe("table");
    expect([...after.settled, ...after.open]).toEqual(fullParse(table + following));
    expect(examined).toBeLessThan((table.length + following.length) * 16);
    expect([...after.settled, ...parser.push("", true).settled]).toEqual(
      fullParse(table + following),
    );
  } finally {
    probe.mockRestore();
  }
});

test("giant open paragraphs keep a plain preview through geometric reparses until closing", () => {
  const parser = new BlockStream();
  let source = "**bold** and [a link](https://example.com) " + "words ".repeat(1400);
  for (let index = 0; index < 30; index++) {
    const append = index === 0 ? source : " more words".repeat(150);
    if (index) source += append;
    const live = parser.push(append, false);
    expect(live.settled).toEqual([]);
    expect(live.open[0]).toEqual({
      type: "paragraph",
      raw: source,
      text: source,
      tokens: [{ type: "text", raw: source, text: source }],
    });
  }
  const after = parser.push("\n\nDone.\n", false);
  expect([...after.settled, ...after.open]).toEqual(fullParse(source + "\n\nDone.\n"));
});
