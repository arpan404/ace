import { isCtrl, typed, type Key } from "./keys.ts";
import { graphemes, graphemeWidth, safeText } from "./layout.ts";

/**
 * The composer (`›`): a small text editor over key presses. Pure. Enter sends; Alt+Enter, or
 * Enter after a trailing `\`, adds a line; Ctrl-G asks for $EDITOR. The text is kept as
 * grapheme clusters so the cursor never lands inside an emoji.
 */
export interface Composer {
  readonly text: string;
  /** Cursor position in grapheme clusters from the start. */
  readonly cursor: number;
}

export type ComposerResult =
  | { kind: "edit"; composer: Composer }
  | { kind: "submit"; text: string; composer: Composer }
  | { kind: "editor"; composer: Composer }
  | { kind: "ignored"; composer: Composer };

export const emptyComposer: Composer = { text: "", cursor: 0 };

export function composerOf(text: string): Composer {
  return { text, cursor: graphemes(text).length };
}

function insert(composer: Composer, value: string): Composer {
  const clusters = graphemes(composer.text);
  const added = graphemes(value);
  clusters.splice(composer.cursor, 0, ...added);
  return { text: clusters.join(""), cursor: composer.cursor + added.length };
}

function remove(composer: Composer, from: number, to: number): Composer {
  const clusters = graphemes(composer.text);
  const start = Math.max(0, Math.min(from, to));
  const end = Math.min(clusters.length, Math.max(from, to));
  clusters.splice(start, end - start);
  return { text: clusters.join(""), cursor: start };
}

/** The start of the word before the cursor, for Ctrl-W and Alt-Backspace. */
function wordStart(clusters: readonly string[], cursor: number): number {
  let at = cursor;
  while (at > 0 && /\s/.test(clusters[at - 1] ?? "")) at--;
  while (at > 0 && !/\s/.test(clusters[at - 1] ?? "")) at--;
  return at;
}

/** Lines of text and where each starts, in clusters. */
function lineStarts(clusters: readonly string[]): number[] {
  const starts = [0];
  clusters.forEach((cluster, index) => {
    if (cluster === "\n") starts.push(index + 1);
  });
  return starts;
}

export function composerKey(composer: Composer, key: Key): ComposerResult {
  const edit = (next: Composer): ComposerResult => ({ kind: "edit", composer: next });
  const clusters = graphemes(composer.text);
  const char = typed(key);
  if (char !== undefined) return edit(insert(composer, char));
  if (key.name === "paste") return edit(insert(composer, safeText(key.text ?? "").replace(/\r\n?/g, "\n")));
  if (key.name === "enter") {
    if (key.alt) return edit(insert(composer, "\n"));
    // A trailing backslash continues the prompt on a new line, as a shell does.
    if (composer.cursor === clusters.length && composer.text.endsWith("\\"))
      return edit(insert(remove(composer, clusters.length - 1, clusters.length), "\n"));
    return { kind: "submit", text: composer.text, composer: emptyComposer };
  }
  if (isCtrl(key, "g")) return { kind: "editor", composer };
  if (isCtrl(key, "j")) return edit(insert(composer, "\n"));
  if (key.name === "backspace") {
    if (key.alt || isCtrl(key, "h"))
      return edit(remove(composer, wordStart(clusters, composer.cursor), composer.cursor));
    return composer.cursor ? edit(remove(composer, composer.cursor - 1, composer.cursor)) : edit(composer);
  }
  if (isCtrl(key, "w"))
    return edit(remove(composer, wordStart(clusters, composer.cursor), composer.cursor));
  if (key.name === "delete" || isCtrl(key, "d"))
    return edit(remove(composer, composer.cursor, composer.cursor + 1));
  if (isCtrl(key, "u")) return edit(remove(composer, 0, composer.cursor));
  if (isCtrl(key, "k")) {
    const end = clusters.indexOf("\n", composer.cursor);
    return edit(remove(composer, composer.cursor, end < 0 ? clusters.length : end));
  }
  if (key.name === "left" || isCtrl(key, "b"))
    return edit({ ...composer, cursor: Math.max(0, composer.cursor - 1) });
  if (key.name === "right" || isCtrl(key, "f"))
    return edit({ ...composer, cursor: Math.min(clusters.length, composer.cursor + 1) });
  const starts = lineStarts(clusters);
  const line = starts.findLastIndex((start) => start <= composer.cursor);
  const lineStart = starts[line] ?? 0;
  const lineEnd = (starts[line + 1] ?? clusters.length + 1) - 1;
  if (key.name === "home" || isCtrl(key, "a")) return edit({ ...composer, cursor: lineStart });
  if (key.name === "end" || isCtrl(key, "e")) return edit({ ...composer, cursor: lineEnd });
  if ((key.name === "up" || key.name === "down") && starts.length > 1) {
    const target = line + (key.name === "up" ? -1 : 1);
    if (target < 0 || target >= starts.length) return { kind: "ignored", composer };
    const column = composer.cursor - lineStart;
    const start = starts[target] ?? 0;
    const end = (starts[target + 1] ?? clusters.length + 1) - 1;
    return edit({ ...composer, cursor: Math.min(end, start + column) });
  }
  return { kind: "ignored", composer };
}

export interface ComposerView {
  readonly lines: string[];
  /** The cursor's line among `lines` and its cell column. */
  readonly cursor: { row: number; column: number };
}

/**
 * The composer drawn at `width`: `› ` before the first line, two spaces before the rest, each
 * line wrapped by cells. `placeholder` shows, dimmed by the caller, while it is empty.
 */
export function composerView(composer: Composer, width: number, placeholder = ""): ComposerView {
  const prompt = "› ";
  const room = Math.max(4, width - 2);
  const lines: string[] = [];
  let row = 0;
  let column = 0;
  let current = "";
  let used = 0;
  let index = 0;
  const clusters = graphemes(composer.text);
  const cursorHere = () => {
    if (index === composer.cursor) {
      row = lines.length;
      column = used;
    }
  };
  for (const cluster of clusters) {
    cursorHere();
    if (cluster === "\n") {
      lines.push(current);
      current = "";
      used = 0;
      index++;
      continue;
    }
    const cells = graphemeWidth(cluster);
    if (used + cells > room) {
      lines.push(current);
      current = "";
      used = 0;
      if (index === composer.cursor) {
        row = lines.length;
        column = 0;
      }
    }
    current += cluster;
    used += cells;
    index++;
  }
  cursorHere();
  lines.push(current);
  if (!composer.text && placeholder) lines[0] = placeholder;
  return {
    lines: lines.map((line, at) => (at === 0 ? prompt : "  ") + line),
    cursor: { row, column: column + 2 },
  };
}
