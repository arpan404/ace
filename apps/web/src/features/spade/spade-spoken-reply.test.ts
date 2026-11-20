import { describe, expect, test } from "vitest";
import {
  spokenCode,
  spokenList,
  spokenReply,
  spokenSentences,
  spokenTable,
} from "./spade-spoken-reply.ts";

/** Feeds `text` in pieces of `size`, as deltas arrive, and collects what is spoken when. */
function streamed(text: string, size: number) {
  const reply = spokenReply();
  const heard: { sentence: string; after: number }[] = [];
  for (let end = size; end < text.length + size; end += size) {
    const sofar = text.slice(0, Math.min(end, text.length));
    for (const sentence of reply.push(sofar)) heard.push({ sentence, after: sofar.length });
  }
  for (const sentence of reply.finish(text)) heard.push({ sentence, after: text.length });
  return heard;
}

describe("a reply is spoken as it streams", () => {
  test("the first sentence is spoken as soon as it is complete, before the reply ends", () => {
    const text = "Your flight leaves at nine. Bring your passport and arrive early. Safe travels";
    const heard = streamed(text, 4);
    expect(heard.map((each) => each.sentence)).toEqual([
      "Your flight leaves at nine.",
      "Bring your passport and arrive early.",
      "Safe travels",
    ]);
    // Spoken within a few characters of its stop, long before the rest arrived.
    expect(heard[0]?.after).toBeLessThanOrEqual("Your flight leaves at nine. ".length + 4);
  });

  test("a sentence ending the words so far is spoken once its space arrives", () => {
    const reply = spokenReply();
    expect(reply.push("Booked.")).toEqual([]);
    expect(reply.push("Booked. ")).toEqual(["Booked."]);
    expect(reply.push("Booked. Seat 12A.  ")).toEqual(["Seat 12A."]);
    expect(reply.finish("Booked. Seat 12A.\nSee you.")).toEqual(["See you."]);
  });

  test("each sentence is spoken once however the reply is cut into deltas", () => {
    const text = "One. Two!\n\nThree? Four…\nFive.";
    for (const size of [1, 2, 3, 7, 50])
      expect(streamed(text, size).map((each) => each.sentence)).toEqual([
        "One.",
        "Two!",
        "Three?",
        "Four…",
        "Five.",
      ]);
  });
});

describe("what is never read aloud", () => {
  test.each([
    ["code", "Here it is:\n```ts\nconst a = 1;\nconsole.log(a);\n```\nRun it.", [
      "Here it is:",
      spokenCode,
      "Run it.",
    ]],
    ["a table", "Prices:\n| Day | Fare |\n|---|---|\n| Mon | $90 |\n\nCheapest is Monday.", [
      "Prices:",
      spokenTable,
      "Cheapest is Monday.",
    ]],
    ["a long list", "Pack:\n- socks\n- shirts\n- charger\n- passport\n- book\nThat's all.", [
      "Pack:",
      spokenList(5),
      "That's all.",
    ]],
  ])("%s becomes one line saying it is on screen", (_, text, expected) => {
    for (const size of [1, 5, 1000])
      expect(streamed(text, size).map((each) => each.sentence)).toEqual(expected);
  });

  test("words inside code are never spoken, even while the block is still being written", () => {
    const heard = streamed("Try:\n```\nrm -rf build. Then rebuild. Done.\n", 3);
    expect(heard.map((each) => each.sentence)).toEqual(["Try:", spokenCode]);
  });

  test("a short list is read item by item", () => {
    expect(spokenSentences("Two options:\n1. **Train** at 9\n2. Bus at 10\n")).toEqual([
      "Two options:",
      "Train at 9.",
      "Bus at 10.",
    ]);
  });

  test("marks and addresses are not read out", () => {
    expect(
      spokenSentences("See the [booking page](https://x.example/a) or https://y.example now."),
    ).toEqual(["See the booking page or a link now."]);
  });

  test("two code blocks in a row are summed up once", () => {
    expect(spokenSentences("```\na\n```\n```\nb\n```\n")).toEqual([spokenCode]);
  });
});
