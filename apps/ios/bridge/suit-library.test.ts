import { afterEach, expect, test } from "vitest";
import "./test-host.ts";
import { fakeSuitHash, type FakeSuitFolder } from "@ace/fake-daemon";
import {
  followSuits,
  readPhoneSuit,
  readSuitAsset,
  solveStillTint,
  SuitRefused,
} from "./suit-library.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * The phone reads its machine's Suit library over the socket: rows for the Look grid, the
 * agent's previews and keeps in order, a Suit resolved for the phone, and its assets as bytes.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

const json = (value: unknown) => JSON.stringify(value);
const tarn: FakeSuitFolder = {
  id: "tarn",
  files: {
    "suit.json": json({
      format: 1,
      id: "tarn",
      name: "Tarn",
      dark: { canvas: "#16181B" },
      thumbnail: { dark: "assets/still.webp" },
      fonts: { mono: { asset: "assets/mono.woff2", family: "Tarn Mono" } },
    }),
    "assets/still.webp": "still",
    "assets/mono.woff2": "mono",
  },
};
const broken: FakeSuitFolder = {
  id: "broken",
  files: { "suit.json": json({ format: 1, id: "broken", name: "Broken" }) },
};

async function connected(folders: FakeSuitFolder[]) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  daemon.suits.set(folders);
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "ready");
  const sink = new RecordingSink();
  closers.push(followSuits(client, sink));
  return { daemon, client, sink };
}

const rows = (sink: RecordingSink) =>
  (sink.read("suits")?.suits as { id: string; unavailable: string | null }[] | undefined) ?? [];

test("the Look grid lists the machine's Suits, saying why one can't be picked", async () => {
  const { sink } = await connected([tarn, broken]);
  await until(() => rows(sink).length === 2, "the list");
  expect(rows(sink).map((row) => [row.id, row.unavailable === null])).toEqual([
    ["broken", false],
    ["tarn", true],
  ]);
  expect(rows(sink)[0]?.unavailable).toBe("set a light or a dark palette (or both)");
});

test("a Suit made on the machine shows up on the phone without asking again", async () => {
  const { daemon, sink } = await connected([]);
  await until(() => sink.read("suits") !== undefined, "the first list");
  daemon.suits.set([tarn]);
  await until(() => rows(sink).length === 1, "the pushed list");
  expect(rows(sink)[0]?.id).toBe("tarn");
});

test("an agent's preview and the keep after it both reach the phone, in order", async () => {
  const { daemon, sink } = await connected([tarn]);
  await until(() => sink.read("suits") !== undefined, "connected");
  daemon.suits.active({ kind: "preview", suitId: "tarn" });
  daemon.suits.active({ kind: "keep", suitId: "tarn", keepId: "k1" });
  await until(() => sink.read("suits.active:2") !== undefined, "both");
  expect([sink.read("suits.active:1")?.active, sink.read("suits.active:2")?.active]).toEqual([
    { kind: "preview", suitId: "tarn" },
    { kind: "keep", suitId: "tarn", keepId: "k1" },
  ]);
});

test("a read Suit comes resolved for the phone, and its still comes as bytes", async () => {
  const { client } = await connected([tarn]);
  const signal = new AbortController().signal;
  const suit = await readPhoneSuit(client, { type: "suit.read", id: "tarn" }, signal);
  expect(suit.colours.light.background).toBe("#16181B");
  expect(suit.stills.light).toBe("assets/still.webp");
  expect(suit.fonts.mono?.asset).toBe("assets/mono.woff2");
  const still = await readSuitAsset(
    client,
    { type: "suit.asset", id: "tarn", contentHash: suit.contentHash, path: "assets/still.webp" },
    signal,
  );
  expect(still).toEqual({ mimeType: "image/webp", data: btoa("still") });
});

test("an asset of an older version, or a Suit that's gone, is refused with the reason", async () => {
  const { client } = await connected([tarn]);
  const signal = new AbortController().signal;
  const stale = fakeSuitHash({ "suit.json": "{}" });
  await expect(
    readSuitAsset(
      client,
      { type: "suit.asset", id: "tarn", contentHash: stale, path: "assets/still.webp" },
      signal,
    ),
  ).rejects.toBeInstanceOf(SuitRefused);
  await expect(readPhoneSuit(client, { type: "suit.read", id: "gone" }, signal)).rejects.toThrow(
    "There is no Suit gone",
  );
});

test("the page over a still thickens until the Suit's words read over its brightest part", () => {
  const colours = {
    background: "#16181B",
    foreground: "#E7EAEE",
    mutedForeground: "#B2B6BC",
    subtleForeground: "#93979E",
    accent: "#D5DEF3",
  };
  const calm = solveStillTint({ type: "suit.stillTint", colours, cells: [[22, 24, 27]] }).tint;
  const bright = solveStillTint({
    type: "suit.stillTint",
    colours,
    cells: [
      [22, 24, 27],
      [250, 250, 250],
    ],
  }).tint;
  expect(calm).toBe(0.4);
  expect(bright).toBeGreaterThan(0.7);
});
