import { z } from "zod";
import { botFaceFieldOrder, botFaceVersion, type BotFace } from "./model.ts";
import { repairFace } from "./rules.ts";

/*
 * A character avatar as Spade stores and sends it:
 * `{"kind":"character","v":1,"body","pair","ears","marking","eyes","mouth","cheeks","accessory"}`.
 * Read leniently: a bad or unknown value is repaired (so the face always draws) and fields this
 * client doesn't know are kept, so a save sends them back untouched.
 */

const characterShape = z.looseObject({ kind: z.literal("character") });

export interface StoredBotFace {
  face: BotFace;
  /** Every field as it came, unknown ones included. */
  raw: Record<string, unknown>;
}

/** The face in a stored character avatar, repaired; undefined when it isn't one. */
export function parseStoredBotFace(raw: unknown): StoredBotFace | undefined {
  const parsed = characterShape.safeParse(raw);
  if (!parsed.success) return undefined;
  return { face: repairFace(parsed.data), raw: parsed.data };
}

/** The avatar to store for `face`, keeping fields a newer client put there. */
export function storedBotFace(
  face: BotFace,
  kept: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...kept, kind: "character", v: botFaceVersion };
  for (const field of botFaceFieldOrder) out[field] = face[field];
  return out;
}
