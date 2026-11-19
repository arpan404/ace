import {
  contrastRatio,
  over,
  parseOpaqueColor,
  rgbToHex,
  rowStatusColours,
  type Palette,
  type Rgb,
  type Scheme,
} from "@ace/themes";

/*
 * A Spade conversation's surfaces (docs/design/spade.md, "Tokens"). The bot's bubble, the raised
 * card that asks something of the person, the well a field sits in and the code well inside a
 * bot bubble are the theme's ink washed over its page, so every theme keeps its own hue and the
 * steps read the same in all of them; solid hex, so contrast checks read them. Raised is the
 * only one with an edge and a lift: being raised means it needs the person.
 *
 * The person's bubble is the accent (`--ring`), the same in every conversation: the colour
 * means "you", a bot's identity is its face. Its text, meta text and inline code are made from
 * the accent's own label colour, so they read on every accent, Ink included.
 */

/** How much ink each step carries over the page, per scheme. */
const ink: Record<Scheme, { bubble: number; raised: number; well: number; code: number }> = {
  // The code well is darker than the bubble it sits in, in both schemes.
  light: { bubble: 0.06, raised: 0, well: 0.035, code: 0.1 },
  dark: { bubble: 0.07, raised: 0.1, well: 0.015, code: 0.01 },
};

/** The person's meta text: this much of the label over the accent, more where that won't read. */
const mineMeta = [0.8, 0.85, 0.9, 0.95, 1] as const;
/** Inline code in the person's bubble: the accent pushed this far away from its label. */
const mineCode = 0.14;
const aa = 4.5;
const black: Rgb = [0, 0, 0];
const white: Rgb = [255, 255, 255];

const opaque = (value: string) => {
  const parsed = parseOpaqueColor(value);
  if (!parsed) throw new Error(`not an opaque colour: ${value}`);
  return parsed;
};

export function chatSurfaces(p: Palette, scheme: Scheme): Record<`--${string}`, string> {
  const page = opaque(p.s0);
  const text = opaque(p.t1);
  const step = (alpha: number) => rgbToHex(over(text, alpha, page));
  const accent = opaque(p.accent);
  const label = opaque(p.accentFg);
  const meta =
    mineMeta.find((alpha) => contrastRatio(over(label, alpha, accent), accent) >= aa) ?? 1;
  // Away from the label: darker under a light label, lighter under a dark one, so the code
  // reads at least as well as the bubble around it.
  const away = contrastRatio(label, black) > contrastRatio(label, white) ? black : white;
  const amounts = ink[scheme];
  // Dark raised: its full step, eased back a hundredth at a time where quiet text wouldn't read.
  const quiet = opaque(p.t3);
  const raised = () => {
    for (let alpha = amounts.raised; alpha > amounts.bubble; alpha -= 0.01) {
      const fill = over(text, alpha, page);
      if (contrastRatio(quiet, fill) >= aa) return rgbToHex(fill);
    }
    return step(amounts.bubble);
  };
  const light = scheme === "light";
  const dots = rowStatusColours[scheme];
  return {
    "--chat-bubble": step(amounts.bubble),
    // In light the card is the floating white; in dark a step above the bubbles.
    "--chat-raised": light ? p.s2 : raised(),
    "--chat-well": step(amounts.well),
    "--chat-code": step(amounts.code),
    "--chat-mine": p.accent,
    "--chat-mine-foreground": p.accentFg,
    "--chat-mine-meta": rgbToHex(over(label, meta, accent)),
    "--chat-mine-code": rgbToHex(over(away, mineCode, accent)),
    "--chat-raised-edge": light ? `rgb(${p.shadow} / 0.08)` : "rgb(255 255 255 / 0.08)",
    "--chat-raised-lift": light
      ? `0 10px 30px rgb(${p.shadow} / 0.1), 0 2px 6px rgb(${p.shadow} / 0.06)`
      : "0 12px 32px rgb(0 0 0 / 0.55), 0 2px 6px rgb(0 0 0 / 0.5)",
    // A face's status dot: only needs-you, failed and off. Working is the face moving, no dot.
    // The thread rows' colours, shared with the iPhone, so a state is one colour everywhere.
    "--face-dot-needs-you": dots["needs-you"],
    "--face-dot-failed": dots.failed,
    "--face-dot-off": dots.background,
  };
}
