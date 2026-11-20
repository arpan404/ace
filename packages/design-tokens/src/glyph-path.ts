/** A point in a glyph's 24×24 box. */
export interface GlyphPoint {
  x: number;
  y: number;
}

/** One drawing step of a glyph's path, in absolute coordinates. */
export type GlyphCommand =
  | { kind: "move"; to: GlyphPoint }
  | { kind: "line"; to: GlyphPoint }
  | { kind: "curve"; to: GlyphPoint; control1: GlyphPoint; control2: GlyphPoint }
  | { kind: "close" };

/**
 * A glyph's SVG path (`agentCursorPath`) as absolute drawing steps, so a surface that can't
 * draw SVG (AppKit, a menu-bar bitmap) draws the same shape. It reads the commands ace's glyphs
 * use: M, L, C and Z, absolute or relative.
 */
export function glyphCommands(path: string): GlyphCommand[] {
  const tokens = path.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const commands: GlyphCommand[] = [];
  let index = 0;
  let at: GlyphPoint = { x: 0, y: 0 };
  let start: GlyphPoint = at;
  let command = "";
  const number = () => {
    const token = tokens[index++];
    const value = Number(token);
    if (token === undefined || !Number.isFinite(value)) throw new Error("Invalid glyph path");
    return value;
  };
  while (index < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[index] ?? "")) command = tokens[index++] ?? "";
    const origin = command === command.toLowerCase() ? at : { x: 0, y: 0 };
    const point = (): GlyphPoint => ({ x: number() + origin.x, y: number() + origin.y });
    switch (command.toLowerCase()) {
      case "m":
        at = point();
        start = at;
        commands.push({ kind: "move", to: at });
        // Pairs after a move are lines, relative when the move was.
        command = command === "m" ? "l" : "L";
        break;
      case "l":
        at = point();
        commands.push({ kind: "line", to: at });
        break;
      case "c": {
        const control1 = point();
        const control2 = point();
        at = point();
        commands.push({ kind: "curve", to: at, control1, control2 });
        break;
      }
      case "z":
        commands.push({ kind: "close" });
        at = start;
        command = "";
        break;
      default:
        throw new Error(`Unsupported glyph path command ${command}`);
    }
  }
  return commands;
}
