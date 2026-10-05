import { Lexer, type Token } from "marked";
import { describe, expect, test } from "vitest";
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
  // Reference definitions arriving late are the exception, covered on their own below.
  for (const [name, text] of Object.entries(samples)) {
    if (name === "references") continue;
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
  test("each finished block crosses to the page once, highlighted once", () => {
    const pieces = chunkings(longAnswer).find(([how]) => how === "16 characters at a time")?.[1];
    if (!pieces) throw new Error("no chunking");
    const sent = replies(pieces).flatMap(settledOf);
    expect(sent.map((block) => block.token)).toEqual(fullParse(longAnswer));
    const fence = sent.find((block) => block.token.type === "code");
    const code = fence?.token.type === "code" ? fence.token.text : "";
    expect(code).toContain("export function replay");
    expect(fence?.code).toEqual(highlight(code, "ts"));
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
