import { over, parseOpaqueColor, rgbToHex, type Palette, type Scheme } from "@ace/themes";

/*
 * A conversation's surfaces, four steps off the page (DESIGN.md, "Conversations"): the bot's
 * bubble, the person's, the raised card that asks something of them, and the well a field or
 * code block sits in. Each is the theme's ink washed over its page, so every theme keeps its own
 * hue and the steps read the same in all of them; solid hex, so contrast checks read them.
 * Raised is the only one with an edge and a lift: being raised means it needs the person.
 */

/** How much ink each step carries over the page, per scheme. */
const ink: Record<Scheme, { bubble: number; mine: number; raised: number; well: number }> = {
  light: { bubble: 0.05, mine: 0.1, raised: 0, well: 0.035 },
  dark: { bubble: 0.04, mine: 0.085, raised: 0.07, well: 0.015 },
};

const opaque = (value: string) => {
  const parsed = parseOpaqueColor(value);
  if (!parsed) throw new Error(`not an opaque colour: ${value}`);
  return parsed;
};

export function chatSurfaces(p: Palette, scheme: Scheme): Record<`--chat-${string}`, string> {
  const page = opaque(p.s0);
  const text = opaque(p.t1);
  const step = (alpha: number) => rgbToHex(over(text, alpha, page));
  const amounts = ink[scheme];
  const light = scheme === "light";
  return {
    "--chat-bubble": step(amounts.bubble),
    "--chat-mine": step(amounts.mine),
    // In light the card is the floating white; in dark a step above the bubbles.
    "--chat-raised": light ? p.s2 : step(amounts.raised),
    "--chat-well": step(amounts.well),
    "--chat-raised-edge": light ? `rgb(${p.shadow} / 0.07)` : "rgb(255 255 255 / 0.07)",
    "--chat-raised-lift": light
      ? `0 10px 30px rgb(${p.shadow} / 0.09), 0 2px 6px rgb(${p.shadow} / 0.06)`
      : "0 12px 32px rgb(0 0 0 / 0.55), 0 2px 6px rgb(0 0 0 / 0.5)",
  };
}
