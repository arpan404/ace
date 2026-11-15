import type { SuitTerminalColours } from "@ace/protocol/suit-parts";
import type { SuitDetail } from "@ace/protocol/suits";
import { revealCeiling } from "@ace/suits";
import { rgbToHex } from "@ace/themes";
import { suitFaceName, systemStack } from "@/theme/suits/suit-css.ts";
import {
  foregroundContrast,
  readable,
  type AnsiName,
  type PaletteOverrides,
  type Rgb,
} from "./palette.ts";
import { terminalText } from "./surface.ts";

/*
 * How a terminal looks under the Suit on screen (`SuitManifest.terminal`, ADR 0150): the text
 * draws on a canvas CSS can't reach, so the Suit's font, cursor, colours and reveal become
 * xterm's options here. Without a Suit, or for anything it leaves unset, the terminal looks as
 * it does under a built-in theme. Pure: the Suit and scheme in, plain values out.
 */

type Rgba = readonly [number, number, number, number];

export interface TerminalLook {
  /** Families to draw with ahead of the app's monospace stack; undefined uses the stack alone. */
  fontFamily: string | undefined;
  /** Bundled faces (`document.fonts.load` specs) that must load before xterm measures a cell. */
  faces: string[];
  fontSize: number;
  /** Row height in CSS px. */
  row: number;
  letterSpacing: number;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  /** The Suit's background for this scheme, drawn under the text instead of the panel's. */
  background: Rgba | undefined;
  colours: PaletteOverrides;
  /** How much of the panel's background or scene the Suit wants behind the text, 0–1. */
  reveal: number;
}

export const defaultTerminalLook: TerminalLook = {
  fontFamily: undefined,
  faces: [],
  fontSize: terminalText.size,
  row: terminalText.row,
  letterSpacing: 0,
  cursorStyle: "block",
  cursorBlink: false,
  background: undefined,
  colours: {},
  reveal: 0,
};

/** `#rrggbb` or `#rrggbbaa` as RGBA bytes. */
function hex(value: string | undefined): Rgba | undefined {
  if (!value || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) return undefined;
  const byte = (at: number) => Number.parseInt(value.slice(at, at + 2), 16);
  return [byte(1), byte(3), byte(5), value.length === 9 ? byte(7) : 255];
}
const rgb = (value: string | undefined): Rgb | undefined => {
  const parsed = hex(value);
  return parsed && [parsed[0], parsed[1], parsed[2]];
};

/** The Suit's colours for one scheme as palette overrides. */
function overrides(colours: SuitTerminalColours | undefined): PaletteOverrides {
  const set: PaletteOverrides = {};
  if (!colours) return set;
  for (const name of ["foreground", "cursor", "cursorAccent"] as const) {
    const value = rgb(colours[name]);
    if (value) set[name] = value;
  }
  for (const [name, value] of Object.entries(colours.ansi ?? {})) {
    const parsed = rgb(value);
    // The protocol's ANSI names are the palette's (`ansiNames`).
    if (parsed) set[name as AnsiName] = parsed;
  }
  const selection = hex(colours.selection);
  if (selection) set.selection = selection;
  return set;
}

/**
 * The terminal's font: a bundled family from the Suit's `fonts` by its internal face name (so
 * it is the file the Suit ships, and it can be awaited), else the value as a system stack when
 * it is safe to place in a font list.
 */
function font(detail: Pick<SuitDetail, "manifest" | "assets">, family: string | undefined) {
  if (!family) return { fontFamily: undefined, faces: [] as string[] };
  const { manifest, assets } = detail;
  for (const slot of ["mono", "ui", "prose"] as const) {
    const bundled = manifest.fonts?.[slot];
    if (bundled && "asset" in bundled && bundled.family === family && assets[bundled.asset]) {
      const face = `"${suitFaceName(manifest.id, slot)}"`;
      return { fontFamily: face, faces: [face] };
    }
  }
  return { fontFamily: systemStack(family), faces: [] as string[] };
}

/** The Suit's own mono face, which the app's monospace stack starts with, when it ships one. */
function monoFaces(detail: Pick<SuitDetail, "manifest" | "assets">): string[] {
  const mono = detail.manifest.fonts?.mono;
  return mono && "asset" in mono && detail.assets[mono.asset]
    ? [`"${suitFaceName(detail.manifest.id, "mono")}"`]
    : [];
}

/** The terminal's look under `suit` in `scheme`; ace's own look without a Suit. */
export function terminalLook(
  suit: Pick<SuitDetail, "manifest" | "assets"> | null,
  scheme: "light" | "dark",
): TerminalLook {
  const terminal = suit?.manifest.terminal;
  if (!suit || !terminal) return defaultTerminalLook;
  const fontSize = terminal.fontSize ?? terminalText.size;
  const lineHeight = terminal.lineHeight ?? terminalText.row / terminalText.size;
  const family = font(suit, terminal.fontFamily);
  const faces = [...new Set([...family.faces, ...monoFaces(suit)])].map(
    (face) => `${fontSize}px ${face}`,
  );
  return {
    fontFamily: family.fontFamily,
    faces,
    fontSize,
    row: Math.round(fontSize * lineHeight),
    letterSpacing: terminal.letterSpacing ?? 0,
    cursorStyle: terminal.cursorStyle ?? "block",
    cursorBlink: terminal.cursorBlink ?? false,
    background: hex(terminal[scheme]?.background),
    colours: overrides(terminal[scheme]),
    reveal: terminal.reveal ?? 0,
  };
}

/**
 * How transparent the terminal's background draws: the Suit's reveal held under what keeps
 * `foreground` readable on `background` over any backdrop (`revealCeiling`), as regions are.
 */
export function terminalReveal(look: TerminalLook, background: Rgb, foreground: Rgb): number {
  if (look.reveal <= 0) return 0;
  const text = readable(foreground, background, foregroundContrast);
  const ceiling = revealCeiling({ text: rgbToHex(text), surface: rgbToHex(background) });
  return Math.min(look.reveal, ceiling);
}
