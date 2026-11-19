/**
 * A bot's character face (direction G): eight stored fields. Everything else (geometry, shading,
 * size tiers, state motion) is drawn from them by pure code. Spade itself is not a bot face: it
 * keeps the flat ink mark. Spade's server (`spade/crates/spade-core/src/face.rs`) holds the same
 * tables; `face-vectors.json` pins the two to the same answers.
 */

export const botFaceFields = {
  body: ["round", "blob", "pebble", "sprout", "ghost", "bot", "fox", "bird", "cloud", "bean"],
  pair: [
    "ember",
    "butter",
    "mint",
    "lagoon",
    "sky",
    "lilac",
    "rose",
    "berry",
    "sage",
    "cocoa",
    "stone",
  ],
  ears: ["none", "cat", "bear", "bunny", "tuft", "nubs"],
  marking: ["none", "cap", "mask", "muzzle", "patch", "stripes", "spots"],
  eyes: ["egg", "round", "big", "sleepy", "almond", "bead"],
  mouth: ["none", "smile", "open", "cat", "o", "grin"],
  cheeks: ["none", "blush", "freckles"],
  accessory: ["none", "bow", "flower", "glasses", "headphones", "beanie", "scarf"],
} as const;

export type BotFaceField = keyof typeof botFaceFields;
export type BotFaceValue<K extends BotFaceField> = (typeof botFaceFields)[K][number];
export type BotBody = BotFaceValue<"body">;
export type BotPair = BotFaceValue<"pair">;

/** A face as stored: `v` is the model version, 1 today. */
export interface BotFace {
  body: BotBody;
  pair: BotPair;
  ears: BotFaceValue<"ears">;
  marking: BotFaceValue<"marking">;
  eyes: BotFaceValue<"eyes">;
  mouth: BotFaceValue<"mouth">;
  cheeks: BotFaceValue<"cheeks">;
  accessory: BotFaceValue<"accessory">;
}

export const botFaceVersion = 1;

/** Field order: the order repair walks and the editor lists. */
export const botFaceFieldOrder: readonly BotFaceField[] = [
  "body",
  "pair",
  "ears",
  "marking",
  "eyes",
  "mouth",
  "cheeks",
  "accessory",
];

export const botFaceDefaults: BotFace = {
  body: "round",
  pair: "lagoon",
  ears: "none",
  marking: "none",
  eyes: "egg",
  mouth: "none",
  cheeks: "none",
  accessory: "none",
};

/** The fields a body narrows; a field it doesn't list takes every value. */
type BodyLimits = Partial<{ [K in BotFaceField]: readonly BotFaceValue<K>[] }>;

/** What each body takes beyond the open fields (pair, eyes, cheeks are open on every body). */
export const botBodyLimits: Record<BotBody, BodyLimits> = {
  round: {},
  blob: {
    ears: ["none", "cat", "bear", "bunny", "nubs"],
    marking: ["none", "cap", "mask", "muzzle", "patch", "spots"],
  },
  pebble: {},
  sprout: {
    ears: ["none"],
    marking: ["none", "mask", "muzzle", "patch", "spots"],
    accessory: ["none", "glasses", "headphones", "scarf"],
  },
  ghost: { accessory: ["none", "bow", "flower", "glasses", "headphones", "beanie"] },
  bot: {
    ears: ["none"],
    marking: ["none", "cap", "stripes", "spots"],
    accessory: ["none", "bow", "flower", "scarf"],
  },
  fox: {
    ears: ["none"],
    marking: ["none", "mask", "patch", "stripes", "spots"],
    accessory: ["none", "flower", "glasses", "scarf"],
  },
  bird: {
    ears: ["none"],
    marking: ["none", "cap", "mask", "patch", "spots"],
    mouth: ["none"],
    accessory: ["none", "bow", "flower", "glasses", "headphones", "scarf"],
  },
  cloud: {
    ears: ["none", "cat", "bear", "bunny"],
    accessory: ["none", "bow", "flower", "glasses", "beanie", "scarf"],
  },
  bean: {},
};

/** Two values that never appear together, whichever was chosen first. */
export interface BotFaceExclusion {
  when: { field: BotFaceField; values: readonly string[] };
  never: { field: BotFaceField; values: readonly string[] };
  why: string;
}

export const botFaceExclusions: readonly BotFaceExclusion[] = [
  {
    when: { field: "ears", values: ["cat", "bear", "bunny"] },
    never: { field: "accessory", values: ["headphones", "bow", "flower", "beanie"] },
    why: "big ears and things worn on or over the ears share the same place",
  },
  {
    when: { field: "ears", values: ["tuft", "nubs"] },
    never: { field: "accessory", values: ["beanie"] },
    why: "a beanie would hide them",
  },
  {
    when: { field: "ears", values: ["tuft"] },
    never: { field: "marking", values: ["stripes"] },
    why: "both sit at the top centre",
  },
  {
    when: { field: "marking", values: ["mask", "patch"] },
    never: { field: "accessory", values: ["glasses"] },
    why: "glasses over a mask or patch lose the eyes",
  },
  {
    when: { field: "marking", values: ["cap"] },
    never: { field: "accessory", values: ["beanie"] },
    why: "two hats",
  },
  {
    when: { field: "marking", values: ["spots"] },
    never: { field: "cheeks", values: ["freckles"] },
    why: "two dot patterns",
  },
];
