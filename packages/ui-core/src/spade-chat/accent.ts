import { botPairColours, faceContrast, type FaceScheme } from "../bot-face/index.ts";
import type { SpadeAvatar } from "./agents.ts";

/*
 * A bot's own accent (ADR 0200 §5.3): one colour that marks only the bot's own things (its card's
 * title rule; later its face ring, its panel's header and its row in lists), never status,
 * approvals, the Working line or a waiting marker. A package's `style.accent` is used when it holds
 * 3:1 on the canvas it is drawn on, as a Suit's accent is checked (ADR 0150); otherwise the face's
 * pair colour, which holds 3:1 on both canvases by design. Spade itself and an uploaded picture
 * have no pair, so they mark nothing.
 */

/** The least contrast an accent mark needs on its canvas (WCAG 1.4.11, non-text). */
export const spadeAccentContrast = 3;

/** The canvases a face's colours are fitted to. */
export const spadeAccentCanvas: Record<FaceScheme, string> = { dark: "#0c0c0c", light: "#ffffff" };

const hex = /^#[0-9a-f]{6}$/i;

export function spadeAgentAccent(
  avatar: SpadeAvatar,
  scheme: FaceScheme,
  style?: { accent?: string | undefined } | undefined,
  canvas: string = spadeAccentCanvas[scheme],
): string | undefined {
  const asked = style?.accent?.trim();
  if (
    asked &&
    hex.test(asked) &&
    hex.test(canvas) &&
    faceContrast(asked, canvas) >= spadeAccentContrast
  )
    return asked;
  if (avatar.kind !== "character") return undefined;
  return botPairColours[avatar.face.pair][scheme].body;
}
