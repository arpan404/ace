import { botPairColours, faceContrast, type FaceScheme } from "../bot-face/index.ts";
import type { SpadeAvatar } from "./agents.ts";

/*
 * A bot's own accent (ADR 0200 §5.3): one colour that marks only the bot's own things (its face
 * ring, its row in lists, its card's title rule; later its panel's header), never status,
 * approvals, the Working line or a waiting marker. A bot's `style.accent` (its package's, or the
 * person's choice in its profile) is used when it holds 3:1 on every canvas it is drawn on, as a
 * Suit's accent is checked (ADR 0150); otherwise the face's pair colour, which holds 3:1 on the
 * standard canvases by design. Spade itself and an uploaded picture have no pair, so they mark
 * nothing.
 */

/** The least contrast an accent mark needs on its canvas (WCAG 1.4.11, non-text). */
export const spadeAccentContrast = 3;

/** The canvases a face's colours are fitted to. */
export const spadeAccentCanvas: Record<FaceScheme, string> = { dark: "#0c0c0c", light: "#ffffff" };

/** The surfaces an accent is drawn on in each scheme: the live Suit's or theme's canvas and panels. */
export type SpadeAccentCanvases = Record<FaceScheme, readonly string[]>;

export const spadeStandardCanvases: SpadeAccentCanvases = {
  dark: [spadeAccentCanvas.dark],
  light: [spadeAccentCanvas.light],
};

const hex = /^#[0-9a-f]{6}$/i;

/** Whether `accent` holds 3:1 on every one of `canvases`; a canvas that isn't a hex is skipped. */
export function spadeAccentHolds(accent: string, canvases: readonly string[]): boolean {
  if (!hex.test(accent)) return false;
  return canvases.every(
    (canvas) => !hex.test(canvas) || faceContrast(accent, canvas) >= spadeAccentContrast,
  );
}

export function spadeAgentAccent(
  avatar: SpadeAvatar,
  scheme: FaceScheme,
  style?: { accent?: string | undefined } | undefined,
  canvases: string | readonly string[] = spadeAccentCanvas[scheme],
): string | undefined {
  const asked = style?.accent?.trim();
  const on = typeof canvases === "string" ? [canvases] : canvases;
  if (asked && spadeAccentHolds(asked, on)) return asked;
  if (avatar.kind !== "character") return undefined;
  return botPairColours[avatar.face.pair][scheme].body;
}

/**
 * The accent a bot's face ring and list row show: only for a bot that has a `style.accent`
 * (its package's or the person's), checked as {@link spadeAgentAccent} checks it. A bot without
 * one marks neither, so a list of ordinary bots stays neutral.
 */
export function spadeBotMarkAccent(
  avatar: SpadeAvatar,
  scheme: FaceScheme,
  style: { accent?: string | undefined } | undefined,
  canvases: string | readonly string[] = spadeAccentCanvas[scheme],
): string | undefined {
  if (!style?.accent) return undefined;
  return spadeAgentAccent(avatar, scheme, style, canvases);
}

/** The colours a bot's profile offers, each a mid tone that holds 3:1 on the standard canvases. */
export const spadeAccentChoices: readonly { name: string; hex: string }[] = [
  { name: "Blue", hex: "#2f7bea" },
  { name: "Teal", hex: "#0f8a8a" },
  { name: "Green", hex: "#2e8b57" },
  { name: "Orange", hex: "#c2410c" },
  { name: "Magenta", hex: "#c2338f" },
  { name: "Violet", hex: "#8b5cf6" },
];

/**
 * The choices that hold 3:1 on every surface of both schemes of the live Suit or theme, so a
 * chosen colour never falls back when the person switches light and dark.
 */
export function spadeAccentChoicesOn(
  canvases: SpadeAccentCanvases,
): readonly { name: string; hex: string }[] {
  const all = [...canvases.light, ...canvases.dark];
  return spadeAccentChoices.filter((choice) => spadeAccentHolds(choice.hex, all));
}
