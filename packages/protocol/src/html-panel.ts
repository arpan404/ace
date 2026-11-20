import { z } from "zod";

/*
 * The one channel between a package's panel page and ace (ADR 0200 §5.2): typed messages only,
 * each checked with these on the host. Into the page: `init`, `theme` and `state`, and the
 * watchdog's `ping`. Out of it: `height`, `action` (for an action its bot.json declares, which the
 * host checks too), and the bridge's `fault` and `pong`. Nothing else crosses.
 */

/** The panel runtime a page is written against: `spade.v1`'s major version. */
export const panelRuntime = "1";
/** The largest message a page may send, as JSON. */
export const maxPanelMessageBytes = 16 * 1024;

const Tokens = z.record(z.string().max(40), z.string().max(400));
const Scheme = z.enum(["light", "dark"]);
const Size = z.strictObject({
  width: z.number().int().min(0).max(100_000),
  height: z.number().int().min(0).max(100_000),
});

export const PanelInit = z.strictObject({
  type: z.literal("ace.panel.init"),
  runtime: z.literal(panelRuntime),
  tokens: Tokens,
  scheme: Scheme,
  reduceMotion: z.boolean(),
  size: Size,
});
export type PanelInit = z.infer<typeof PanelInit>;
export const PanelTheme = z.strictObject({
  type: z.literal("ace.panel.theme"),
  tokens: Tokens,
  scheme: Scheme,
});
export type PanelTheme = z.infer<typeof PanelTheme>;
export const PanelState = z.strictObject({ type: z.literal("ace.panel.state"), data: z.unknown() });
export type PanelState = z.infer<typeof PanelState>;
export const PanelPing = z.strictObject({
  type: z.literal("ace.panel.ping"),
  n: z.number().int().nonnegative(),
});
export type PanelPing = z.infer<typeof PanelPing>;
/** What ace sends a panel's page. */
export type PanelHostMessage = PanelInit | PanelTheme | PanelState | PanelPing;

/** What a panel's page may send. A message of any other shape is dropped. */
export const PanelPageMessage = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ace.html.height"),
    height: z.number().finite().min(1).max(10000),
  }),
  z.strictObject({
    type: z.literal("ace.panel.action"),
    name: z.string().min(1).max(40),
    value: z.unknown().optional(),
  }),
  z.strictObject({ type: z.literal("ace.panel.fault") }),
  z.strictObject({ type: z.literal("ace.panel.pong"), n: z.number().int().nonnegative() }),
]);
export type PanelPageMessage = z.infer<typeof PanelPageMessage>;
