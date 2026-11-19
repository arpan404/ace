import {
  botBodyLimits,
  botFaceDefaults,
  botFaceExclusions,
  botFaceFieldOrder,
  botFaceFields,
  type BotFace,
  type BotFaceField,
  type BotFaceValue,
} from "./model.ts";

/*
 * Which values a face may take, and how any face is brought back to a valid one. The server
 * (`spade-core/src/face.rs`) repeats these rules; `face-vectors.json` pins them together.
 */

/**
 * The values of `field` allowed on `face`: the field's values, narrowed by the body, minus those
 * an exclusion rules out against the face's other fields. Body and pair are always open.
 */
export function allowedFaceValues<K extends BotFaceField>(
  field: K,
  face: BotFace,
): readonly BotFaceValue<K>[] {
  const all = botFaceFields[field] as readonly BotFaceValue<K>[];
  const limit = botBodyLimits[face.body][field] as readonly BotFaceValue<K>[] | undefined;
  let values = limit ? all.filter((value) => limit.includes(value)) : all;
  for (const rule of botFaceExclusions) {
    if (field === rule.never.field && rule.when.values.includes(face[rule.when.field]))
      values = values.filter((value) => !rule.never.values.includes(value));
    if (field === rule.when.field && rule.never.values.includes(face[rule.never.field]))
      values = values.filter((value) => !rule.when.values.includes(value));
  }
  return values;
}

/** Whether every field holds a value allowed on the face. */
export function isValidFace(face: BotFace): boolean {
  return botFaceFieldOrder.every((field) =>
    (allowedFaceValues(field, face) as readonly string[]).includes(face[field]),
  );
}

/**
 * Every field but `kept` (and body and pair) that is no longer allowed falls back to its first
 * allowed value: `none` for every optional field. Changing the body is how a person gets past an
 * exclusion; the rest repairs itself.
 */
export function settleFace(face: BotFace, kept?: BotFaceField): BotFace {
  const next = { ...face };
  for (let pass = 0; pass < 3; pass++) {
    for (const field of botFaceFieldOrder) {
      if (field === kept || field === "body" || field === "pair") continue;
      const allowed = allowedFaceValues(field, next) as readonly string[];
      if (!allowed.includes(next[field])) Object.assign(next, { [field]: allowed[0] });
    }
  }
  return next;
}

/** The face with `field` set to `value`, the other fields repaired around it. */
export function changeFace<K extends BotFaceField>(
  face: BotFace,
  field: K,
  value: BotFaceValue<K>,
): BotFace {
  return settleFace({ ...face, [field]: value }, field);
}

/** The next allowed value of `field` after the face's own, wrapping: a click on that part. */
export function stepFace(face: BotFace, field: BotFaceField): BotFace {
  const values = allowedFaceValues(field, face) as readonly string[];
  const at = values.indexOf(face[field]);
  const next = values[(at + 1) % values.length] ?? face[field];
  return changeFace(face, field, next as BotFaceValue<typeof field>);
}

/**
 * Any stored or hand-made face as a valid one: an unknown or missing value takes the default,
 * then the rules repair the rest, so whatever was stored always draws.
 */
export function repairFace(raw: Readonly<Record<string, unknown>>): BotFace {
  const face = { ...botFaceDefaults };
  for (const field of botFaceFieldOrder) {
    const value = raw[field];
    if (typeof value === "string" && (botFaceFields[field] as readonly string[]).includes(value))
      Object.assign(face, { [field]: value });
  }
  return settleFace(face);
}
