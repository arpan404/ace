import type { BotFaceField } from "./model.ts";

/*
 * The editor's words and the big face's click targets. Clicking a drawn part (`data-part` in the
 * markup) steps the field it stands for; clicking the body steps its colours.
 */

/** The field a click on each drawn part steps. */
export const botFacePartField: Readonly<Record<string, BotFaceField>> = {
  body: "pair",
  ears: "ears",
  marking: "marking",
  eyes: "eyes",
  mouth: "mouth",
  cheeks: "cheeks",
  accessory: "accessory",
};

/** Each field's label in the editor, in its order. */
export const botFaceFieldLabels: Readonly<Record<BotFaceField, string>> = {
  body: "Creature",
  pair: "Colours",
  ears: "Ears",
  marking: "Marking",
  eyes: "Eyes",
  mouth: "Mouth",
  cheeks: "Cheeks",
  accessory: "Extra",
};
