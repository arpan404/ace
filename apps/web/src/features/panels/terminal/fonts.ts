/**
 * Faces for glyphs a monospace face lacks. Prompt glyphs (powerline, devicons, codicons) sit
 * in the Private Use Area, which no common monospace face covers, so without one of the Nerd
 * Font faces people install for their prompts they draw as boxes. The system's symbol and
 * emoji faces follow.
 */
const symbolFaces = [
  "Symbols Nerd Font Mono",
  "Symbols Nerd Font",
  "JetBrainsMono NFM",
  "JetBrainsMono NF",
  "JetBrainsMono Nerd Font Mono",
  "JetBrainsMono Nerd Font",
  "MesloLGS NF",
  "MesloLGS Nerd Font Mono",
  "Hack Nerd Font Mono",
  "Hack Nerd Font",
  "FiraCode Nerd Font Mono",
  "FiraCode Nerd Font",
  "CaskaydiaCove Nerd Font Mono",
  "CaskaydiaCove NF",
  "Apple Symbols",
  "Segoe UI Symbol",
  "Noto Sans Symbols 2",
  "Noto Sans Symbols",
  "Apple Color Emoji",
  "Segoe UI Emoji",
  "Noto Color Emoji",
];

const generic = new Set(["monospace", "ui-monospace", "sans-serif", "serif", "system-ui"]);
const unquote = (face: string) => face.trim().replace(/^["']|["']$/g, "");

/**
 * The font stack a terminal renderer draws `element` with: its resolved monospace family
 * (the theme's `--font-mono`, already expanded by the browser) with the symbol faces added.
 */
export function terminalFont(element: Element): string {
  return terminalFontFamily(getComputedStyle(element).fontFamily || "monospace");
}

/**
 * The terminal's font stack: the app's monospace faces first, unchanged, then the symbol faces,
 * then the generic families. A browser falls back one character at a time, so only glyphs the
 * monospace faces lack come from the symbol faces.
 */
export function terminalFontFamily(monospace: string): string {
  // A Suit's family ahead of a stack that already starts with it would repeat faces: keep the first.
  const seen = new Set<string>();
  const faces = monospace
    .split(",")
    .map((face) => face.trim())
    .filter((face) => {
      const key = unquote(face);
      if (!face || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const named = faces.filter((face) => !generic.has(unquote(face)));
  const generics = faces.filter((face) => generic.has(unquote(face)));
  const have = new Set(named.map(unquote));
  const symbols = symbolFaces.filter((face) => !have.has(face)).map((face) => `"${face}"`);
  return [...named, ...symbols, ...(generics.length ? generics : ["monospace"])].join(", ");
}

/**
 * Waits for a Suit's bundled faces (`TerminalLook.faces`) before xterm measures its cell, so the
 * grid is sized to the face it will draw with, never a fallback's. Bounded: a face that never
 * loads leaves the terminal on the next face in its stack after `timeoutMs`.
 */
export async function loadFaces(
  faces: readonly string[],
  fonts: Pick<FontFaceSet, "load"> | undefined,
  timeoutMs = 2000,
): Promise<void> {
  if (!fonts || faces.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((settle) => (timer = setTimeout(settle, timeoutMs)));
  const loaded = Promise.all(faces.map((face) => fonts.load(face).catch(() => []))).then(() => {});
  await Promise.race([loaded, late]);
  clearTimeout(timer);
}
