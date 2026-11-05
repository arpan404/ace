/**
 * ace's own glyph geometry, shared by every surface that draws it: the web app's icons, the
 * agent cursor injected into pages, and native clients. Coordinates are in a 24×24 box.
 */

/**
 * The agent cursor, "Pebble": a soft rounded arrow. Filled with the person's accent and drawn
 * with an outline (`agentCursorOutline` wide, round joins) and a soft shadow so it reads on any
 * page. Its tip, the point that clicks, is `agentCursorTip`.
 */
export const agentCursorPath =
  "M7.2 4.7C5.4 3.9 3.7 5.6 4.4 7.4l3.9 10.2c.65 1.7 3.05 1.75 3.8.1l1.1-2.45c.25-.55.7-.97 1.27-1.15l2.55-.82c1.8-.58 1.9-3.08.15-3.82z";
export const agentCursorOutline = 1.6;
export const agentCursorTip = { x: 4.6, y: 4.9 } as const;
export const glyphBox = 24;

/** The stroke every outlined ace glyph shares, Phosphor regular's on the 24 box. */
export const glyphStroke = 1.5;

/** Where a glyph sets the agent cursor: scaled by `scale`, its tip at `tip`. */
export interface PointerPlacement {
  scale: number;
  tip: { x: number; y: number };
}

/**
 * Computer use: the agent's pointer with three short rays at its tip, an agent acting in apps.
 * No window or monitor box: the pointer is the whole idea.
 */
export const computerUseGlyph = {
  pointer: { scale: 0.8, tip: { x: 9, y: 9 } } satisfies PointerPlacement,
  rays: "M9 2.75v2M2.75 9h2M4.6 4.6l1.4 1.4",
} as const;

/**
 * Browser use: a globe with the agent's pointer resting on its lower right. The globe is cut
 * away around the pointer by `knockout` strokes, so the two read apart at 14px.
 */
export const browserUseGlyph = {
  pointer: { scale: 0.62, tip: { x: 12.6, y: 12.6 } } satisfies PointerPlacement,
  globe: { cx: 10.5, cy: 10.5, r: 7.5, rx: 3.25 },
  equator: "M3 10.5h15",
  knockout: 3,
} as const;

/** ace's own tools: the ace mark at this share of the 24 box, so its solid wings sit level with outlined glyphs. */
export const aceToolScale = 0.82;
