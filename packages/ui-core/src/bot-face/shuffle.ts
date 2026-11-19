import {
  botFaceDefaults,
  botFaceFields,
  type BotBody,
  type BotFace,
  type BotFaceValue,
  type BotPair,
} from "./model.ts";
import { allowedFaceValues, settleFace } from "./rules.ts";

/*
 * Shuffle: only well-formed faces, weighted toward the friendlier ones. The server makes the
 * same faces from the same numbers (`spade-core/src/face.rs`), so a seed gives one face on both.
 */

/** A number in [0, 1), as `Math.random` gives; injected so tests and seeds can drive it. */
export type FaceRandom = () => number;

type Weights<T extends string> = readonly (readonly [T, number])[];

const bodyWeights: Weights<BotBody> = [
  ["round", 18],
  ["blob", 10],
  ["pebble", 8],
  ["sprout", 8],
  ["ghost", 9],
  ["bot", 8],
  ["fox", 9],
  ["bird", 9],
  ["cloud", 8],
  ["bean", 8],
];

/** Bodies that look best in a few pairs; the rest take any. */
export const botPairsFor: Partial<Record<BotBody, readonly BotPair[]>> = {
  ghost: ["stone", "lilac", "mint", "sky"],
  sprout: ["mint", "sage", "butter", "lagoon"],
  fox: ["ember", "cocoa", "butter", "berry"],
  bird: ["sky", "lagoon", "butter", "berry", "rose"],
  bot: ["stone", "sky", "lagoon", "mint", "butter"],
  cloud: ["sky", "lilac", "stone", "rose"],
};

const eyesWeights: Weights<BotFaceValue<"eyes">> = [
  ["egg", 30],
  ["round", 20],
  ["big", 20],
  ["sleepy", 10],
  ["almond", 10],
  ["bead", 10],
];
const mouthWeights: Weights<BotFaceValue<"mouth">> = [
  ["none", 35],
  ["smile", 25],
  ["cat", 12],
  ["o", 8],
  ["open", 12],
  ["grin", 8],
];
const cheeksWeights: Weights<BotFaceValue<"cheeks">> = [
  ["none", 45],
  ["blush", 40],
  ["freckles", 15],
];
const decorationCount: Weights<"0" | "1" | "2"> = [
  ["0", 25],
  ["1", 45],
  ["2", 30],
];

/** Ears, marking and extra: at most two on a face, one on a species with its own features. */
export const botFaceDecorations = ["ears", "marking", "accessory"] as const;
export const botMaxDecorations = 2;
const maxDecorationsFor: Partial<Record<BotBody, number>> = { sprout: 1, bot: 1, fox: 1, bird: 1 };

function pick<T>(random: FaceRandom, list: readonly T[]): T {
  const at = Math.min(list.length - 1, Math.floor(random() * list.length));
  return list[at] as T;
}

function weighted<T extends string>(random: FaceRandom, table: Weights<T>): T {
  const total = table.reduce((sum, [, weight]) => sum + weight, 0);
  let left = random() * total;
  for (const [value, weight] of table) {
    left -= weight;
    if (left < 0) return value;
  }
  return (table[0] as readonly [T, number])[0];
}

/** A pair no other bot wears when one is left in the body's list; else any but the current. */
function freshPair(
  random: FaceRandom,
  current: BotPair | undefined,
  taken: ReadonlySet<string>,
  body: BotBody,
): BotPair {
  const pool = (botPairsFor[body] ?? botFaceFields.pair).filter((pair) => pair !== current);
  const free = pool.filter((pair) => !taken.has(pair));
  return pick(random, free.length ? free : pool.length ? pool : botFaceFields.pair);
}

/**
 * A new face: a body other than the current one by weight, a pair (preferring ones no other bot
 * wears), eyes, mouth and cheeks by weight, and up to two decorations, each from the values
 * allowed at that moment. Freckles become blush beside a decoration. Always valid.
 */
export function shuffleFace(
  random: FaceRandom,
  current?: BotFace,
  takenPairs: Iterable<string> = [],
): BotFace {
  const taken = new Set(takenPairs);
  const body = weighted(
    random,
    bodyWeights.filter(([value]) => value !== current?.body),
  );
  const face: BotFace = {
    ...botFaceDefaults,
    body,
    pair: freshPair(random, current?.pair, taken, body),
    eyes: weighted(random, eyesWeights),
    cheeks: weighted(random, cheeksWeights),
  };
  if (allowedFaceValues("mouth", face).length > 1) face.mouth = weighted(random, mouthWeights);
  const budget = Math.min(
    Number(weighted(random, decorationCount)),
    maxDecorationsFor[body] ?? botMaxDecorations,
  );
  const slots = [...botFaceDecorations];
  for (let index = slots.length - 1; index > 0; index--) {
    const other = Math.min(index, Math.floor(random() * (index + 1)));
    const here = slots[index];
    const there = slots[other];
    if (here && there) {
      slots[index] = there;
      slots[other] = here;
    }
  }
  let used = 0;
  for (const slot of slots) {
    if (used >= budget) break;
    const values = (allowedFaceValues(slot, face) as readonly string[]).filter((v) => v !== "none");
    if (!values.length) continue;
    Object.assign(face, { [slot]: pick(random, values) });
    used++;
  }
  if (used && face.cheeks === "freckles") face.cheeks = "blush";
  return settleFace(face);
}

/** FNV-1a over the UTF-8 bytes: the same 32-bit seed in every language. */
export function faceSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Mulberry32: a small seeded generator both languages compute bit for bit. */
export function seededRandom(seed: number): FaceRandom {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state) >>> 0;
    t = ((t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The face an agent without one gets: a shuffle seeded by its id, the same everywhere. */
export function faceForId(id: string, takenPairs: Iterable<string> = []): BotFace {
  return shuffleFace(seededRandom(faceSeed(id)), undefined, takenPairs);
}
