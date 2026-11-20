import {
  allowedFaceValues,
  botFaceFieldLabels,
  botFaceFieldOrder,
  botFaceFields,
  changeFace,
  suggestBotNames,
  type BotFace,
  type BotFaceField,
  type BotFaceValue,
} from "@ace/ui-core/bot-face";

/*
 * The /spade/ page's face maker, as pure rules over the app's own character model
 * (`@ace/ui-core/bot-face`): which parts can change, what each offers, how a choice repairs the
 * rest, and the name a nameless bot is shown with. scripts/spade-maker-ui.ts draws it.
 */

/** The parts in the app editor's order, with its labels (Creature, Colours, …, Extra). */
export const makerParts: readonly { field: BotFaceField; label: string }[] = botFaceFieldOrder.map(
  (field) => ({ field, label: botFaceFieldLabels[field] }),
);

/** What a part offers on this face: every creature and colour; the rest as the rules allow. */
export function partOptions(face: BotFace, field: BotFaceField): readonly string[] {
  return field === "body" || field === "pair"
    ? botFaceFields[field]
    : allowedFaceValues(field, face);
}

/** Whether a part has anything to choose on this face (a bird has no mouth to pick). */
export function partOpen(face: BotFace, field: BotFaceField): boolean {
  return partOptions(face, field).length > 1;
}

/** The face with `value` chosen for `field`, the other parts repaired; unchanged for a value the part doesn't offer. */
export function choosePart(face: BotFace, field: BotFaceField, value: string): BotFace {
  if (!partOptions(face, field).includes(value)) return face;
  return changeFace(face, field, value as BotFaceValue<typeof field>);
}

/** A value as a person reads it: "headphones" → "Headphones". */
export function optionName(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The name shown under the face: what was typed, else the first name that suits the face. */
export function shownName(face: BotFace, typed: string): string {
  return typed.trim() || suggestBotNames(face, "", 1)[0] || "Bot";
}
