import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allowedFaceValues,
  botFaceDecorations,
  botFaceFields,
  botFaceMarkup,
  changeFace,
  faceContrast,
  faceForId,
  isValidFace,
  parseStoredBotFace,
  repairFace,
  seededRandom,
  shuffleFace,
  stepFace,
  storedBotFace,
  suggestBotNames,
  botPairColours,
  botFaceStateAfter,
  botFaceStateOf,
  type BotFace,
} from "./index.ts";

/** Shared with Spade's server, which must answer the same (spade-core/src/face/tests.rs). */
const vectors = JSON.parse(
  readFileSync(
    new URL("../../../../spade/crates/spade-core/src/face/vectors.json", import.meta.url),
    "utf8",
  ),
) as {
  repair: { input: Record<string, unknown>; output: BotFace }[];
  seeded: { id: string; taken?: string[]; output: BotFace }[];
};

const decorations = (face: BotFace) => botFaceDecorations.filter((f) => face[f] !== "none").length;

describe("repair", () => {
  it("gives the same face as Spade's server for every shared vector", () => {
    expect(vectors.repair.length).toBeGreaterThanOrEqual(40);
    for (const { input, output } of vectors.repair) expect(repairFace(input)).toEqual(output);
  });

  it("turns any garbage into a valid, drawable face", () => {
    const random = seededRandom(99);
    const junk: unknown[] = [null, 3, "", "ROUND", ["round"], {}, "freckles", "glasses"];
    for (let round = 0; round < 2000; round++) {
      const raw: Record<string, unknown> = {};
      for (const [field, values] of Object.entries(botFaceFields))
        raw[field] =
          random() < 0.7
            ? values[Math.floor(random() * values.length)]
            : junk[Math.floor(random() * junk.length)];
      const face = repairFace(raw);
      expect(isValidFace(face)).toBe(true);
      expect(botFaceMarkup(face, 32, "t")).toContain("bf-ey");
    }
  });

  it("drops what the body can't wear and keeps the rest", () => {
    const face = repairFace({ body: "bird", mouth: "grin", eyes: "big", pair: "rose" });
    expect(face).toMatchObject({ body: "bird", mouth: "none", eyes: "big", pair: "rose" });
  });
});

describe("shuffle", () => {
  it("keeps every body rule, exclusion and the decoration limits over many seeds", () => {
    for (let seed = 0; seed < 3000; seed++) {
      const random = seededRandom(seed);
      const current = shuffleFace(random);
      const face = shuffleFace(random, current);
      expect(isValidFace(face)).toBe(true);
      expect(face.body).not.toBe(current.body);
      const cap = ["sprout", "bot", "fox", "bird"].includes(face.body) ? 1 : 2;
      expect(decorations(face)).toBeLessThanOrEqual(cap);
      if (decorations(face) > 0) expect(face.cheeks).not.toBe("freckles");
    }
  });

  it("prefers a colour pair no other bot wears", () => {
    const taken = ["ember", "butter", "mint", "lagoon", "sky", "lilac", "rose"];
    let fresh = 0;
    for (let seed = 0; seed < 400; seed++) {
      const face = shuffleFace(seededRandom(seed), undefined, taken);
      if (!taken.includes(face.pair)) fresh++;
    }
    // Only a body whose short list is all taken may repeat a pair.
    expect(fresh).toBeGreaterThan(300);
    const untaken = shuffleFace(seededRandom(1), undefined, []);
    expect(isValidFace(untaken)).toBe(true);
  });

  it("seeds the same face from an id as Spade's server", () => {
    for (const { id, taken, output } of vectors.seeded)
      expect(faceForId(id, taken)).toEqual(output);
  });
});

describe("editing", () => {
  it("hides an excluded value either way round and repairs past it on a body change", () => {
    const eared = changeFace(repairFace({}), "ears", "bunny");
    expect(allowedFaceValues("accessory", eared)).not.toContain("headphones");
    const wearing = changeFace(repairFace({}), "accessory", "headphones");
    expect(allowedFaceValues("ears", wearing)).not.toContain("bunny");
    const switched = changeFace(wearing, "ears", "bunny");
    expect(switched).toMatchObject({ ears: "bunny", accessory: "none" });
    expect(changeFace(eared, "body", "bot")).toMatchObject({ body: "bot", ears: "none" });
  });

  it("steps a part through its allowed values and wraps", () => {
    let face = repairFace({ body: "bird" });
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      face = stepFace(face, "accessory");
      seen.add(face.accessory);
    }
    expect([...seen].toSorted()).toEqual([...allowedFaceValues("accessory", face)].toSorted());
  });

  it("suggests the same names for the same face, never the one it has", () => {
    const face = repairFace({ body: "fox" });
    expect(suggestBotNames(face)).toEqual(suggestBotNames({ ...face }));
    expect(suggestBotNames(face, "Rusty")).not.toContain("Rusty");
    expect(suggestBotNames(face)).toHaveLength(3);
  });
});

describe("stored faces", () => {
  it("reads a stored character, keeping fields it doesn't know for the next save", () => {
    const read = parseStoredBotFace({
      kind: "character",
      v: 1,
      body: "ghost",
      ears: "wings",
      glow: true,
    });
    expect(read?.face).toMatchObject({ body: "ghost", ears: "none" });
    if (!read) throw new Error("a character avatar reads");
    expect(storedBotFace(read.face, read.raw)).toMatchObject({
      kind: "character",
      v: 1,
      glow: true,
      body: "ghost",
    });
    expect(parseStoredBotFace({ kind: "generated", color: "teal" })).toBeUndefined();
  });
});

describe("colours", () => {
  it("holds 3:1 for every pair on its own canvas", () => {
    for (const pair of Object.values(botPairColours)) {
      expect(faceContrast(pair.dark.body, "#0c0c0c")).toBeGreaterThanOrEqual(3);
      expect(faceContrast(pair.light.body, "#ffffff")).toBeGreaterThanOrEqual(3);
      expect(faceContrast(pair.light.accent, "#ffffff")).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("states", () => {
  it("acknowledges new work, shows done when work ends, and otherwise follows the agent", () => {
    expect(botFaceStateAfter("idle", "working")).toBe("acknowledge");
    expect(botFaceStateAfter("done", "thinking")).toBe("acknowledge");
    expect(botFaceStateAfter("working", "thinking")).toBe("thinking");
    expect(botFaceStateAfter("needs-you", "working")).toBe("working");
    expect(botFaceStateAfter("working", "idle")).toBe("done");
    expect(botFaceStateAfter("needs-you", "idle")).toBe("done");
    expect(botFaceStateAfter("idle", "idle")).toBe("idle");
    expect(botFaceStateAfter("working", "needs-you")).toBe("needs-you");
  });

  it("reads the face's state from what Spade says the agent is doing", () => {
    expect(botFaceStateOf({ state: "waiting" })).toBe("needs-you");
    expect(botFaceStateOf({ state: "working", status: "Thinking" })).toBe("thinking");
    expect(botFaceStateOf({ state: "working", status: "Reading a page" })).toBe("working");
    expect(botFaceStateOf({ state: "idle", problem: "Signed out" })).toBe("blocked");
    expect(botFaceStateOf({ state: "idle" })).toBe("idle");
  });
});
