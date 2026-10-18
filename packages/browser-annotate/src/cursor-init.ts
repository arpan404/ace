/** The agent cursor's colours: the person's accent and the outline that reads on it. */
export interface CursorStyle {
  fill: string;
  outline: string;
}

/** Everything the page side needs to start: JSON only, built by `cursorInstallExpression`. */
export interface CursorInit {
  style: CursorStyle;
  font: string;
  /** How long the cursor glides to a new point; the daemon waits as long before acting. */
  glideMs: number;
  motion: { fast: number; standard: number; enter: string };
  /** Pebble geometry (`@ace/design-tokens/glyphs`). */
  glyph: { path: string; outline: number; tip: { x: number; y: number } };
  secretSelector: string;
}

export interface CursorPoint {
  x: number;
  y: number;
}
export interface CursorRect extends CursorPoint {
  width: number;
  height: number;
}

/**
 * One change to the page's cursors. Every op carries complete state for what it touches, so a
 * reinstalled overlay (after a navigation or a renderer restart) catches up by replaying the
 * daemon's current state.
 */
export type CursorOp =
  | { op: "agent"; id: string; name: string; at: CursorPoint; glide: boolean }
  | { op: "leave"; id: string }
  | { op: "click"; id: string }
  | { op: "drag"; id: string; from: CursorPoint; to: CursorPoint }
  | { op: "type"; id: string; field: CursorRect }
  | { op: "scroll"; id: string; dx: number; dy: number }
  | { op: "style"; style: CursorStyle }
  /** The person is using the page: cursors fade out until they pause. */
  | { op: "person"; active: boolean }
  /** Captures and recordings: cursors vanish at once and secret fields are masked. */
  | { op: "capture"; hidden: boolean; mask: boolean };
