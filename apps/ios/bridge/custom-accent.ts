import { phoneCustomAccent, type PhoneCustomAccent } from "@ace/themes";
import { z } from "zod";

/*
 * Settings › Appearance's custom accent: the picked colour fitted to every theme in both schemes
 * with the web's own fitting (`@ace/themes` phoneCustomAccent). Swift sends the colour and keeps
 * the answer, so a theme switch later needs no runtime.
 */

export const CustomAccentRequest = z.object({
  type: z.literal("appearance.customAccent"),
  colour: z.string().regex(/^#[0-9a-f]{6}$/i),
});
export type CustomAccentRequest = z.infer<typeof CustomAccentRequest>;

export interface CustomAccentReply {
  type: "appearance.customAccent";
  colour: string;
  /** Theme id → scheme → the phone's accent and the label on it. */
  themes: PhoneCustomAccent;
}

export function fitCustomAccent(request: CustomAccentRequest): CustomAccentReply | undefined {
  const colour = request.colour.toUpperCase();
  const themes = phoneCustomAccent(colour);
  return themes ? { type: "appearance.customAccent", colour, themes } : undefined;
}
