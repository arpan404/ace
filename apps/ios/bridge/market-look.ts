import type { MarketResult } from "@ace/protocol/marketplace";
import { SuitManifest, type SuitPalette } from "@ace/protocol/suits";
import { parseStoredBotFace } from "@ace/ui-core/bot-face";

function swatches(palette: SuitPalette | undefined) {
  return [palette?.canvas, palette?.sidebar, palette?.surface, palette?.accent].filter(
    (color): color is string => color !== undefined,
  );
}

export function lookAnswer(type: string, look: Extract<MarketResult, { op: "look" }>) {
  if (type === "spade-bot") return { face: parseStoredBotFace(look.face)?.face ?? null };
  if (type !== "suit" || !look.suit) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(look.suit);
  } catch {
    return {};
  }
  const suit = SuitManifest.safeParse(raw);
  return suit.success ? { light: swatches(suit.data.light), dark: swatches(suit.data.dark) } : {};
}
