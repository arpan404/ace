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
