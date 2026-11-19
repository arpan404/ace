import { z } from "zod";
import { diffTexts } from "./diff.ts";

/** One entry of a rendered diff: kept as it was, removed, or added. */
export interface RenderedChange<T> {
  kind: "same" | "del" | "add";
  item: T;
}

/**
 * Two lists of blocks compared as wholes: each block is one token, so the shared line diff (its
 * LCS and its handling of very long files) decides what was kept, removed and added.
 */
export function blockDiff<T>(
  before: readonly T[],
  after: readonly T[],
  key: (item: T) => string,
): RenderedChange<T>[] {
  const ids = new Map<string, number>();
  const token = (item: T) => {
    const text = key(item);
    let id = ids.get(text);
    if (id === undefined) ids.set(text, (id = ids.size));
    return String(id);
  };
  const tokens = (items: readonly T[]) => items.map((item) => `${token(item)}\n`).join("");
  const changes: RenderedChange<T>[] = [];
  for (const line of diffTexts(tokens(before), tokens(after))) {
    const item = line.kind === "del" ? before[(line.old ?? 0) - 1] : after[(line.new ?? 0) - 1];
    if (item !== undefined)
      changes.push({ kind: line.kind === "context" ? "same" : line.kind, item });
  }
  return changes;
}

/** A markdown document's blocks: runs of lines between blank lines, a fenced block kept whole. */
export function markdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    if (lines.length) blocks.push(lines.join("\n"));
    lines = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || marker.startsWith(fence))) fence = fence ? undefined : marker;
    if (!fence && !marker && line.trim() === "") flush();
    else lines.push(line);
  }
  flush();
  return blocks;
}

export type NotebookOutput =
  | { kind: "text"; text: string; error: boolean }
  | { kind: "image"; url: string };
export interface NotebookCell {
  kind: "markdown" | "code" | "raw";
  source: string;
  outputs: NotebookOutput[];
}
export interface Notebook {
  language: string;
  cells: NotebookCell[];
}

const multiline = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (typeof value === "string" ? value : value.join("")));
const Output = z.looseObject({
  output_type: z.string(),
  text: multiline.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  ename: z.string().optional(),
  evalue: z.string().optional(),
  traceback: z.array(z.string()).optional(),
});
const NotebookFile = z.looseObject({
  cells: z.array(
    z.looseObject({
      cell_type: z.string(),
      source: multiline.optional(),
      outputs: z.array(z.unknown()).optional(),
    }),
  ),
  metadata: z
    .looseObject({
      language_info: z.looseObject({ name: z.string().optional() }).optional(),
      kernelspec: z.looseObject({ language: z.string().optional() }).optional(),
    })
    .optional(),
});
const imageOutputs = ["image/png", "image/jpeg", "image/gif"] as const;
// Terminal colour codes in tracebacks.
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

function output(raw: unknown): NotebookOutput | undefined {
  const parsed = Output.safeParse(raw);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  if (value.output_type === "stream" && value.text !== undefined)
    return { kind: "text", text: value.text, error: false };
  if (value.output_type === "error")
    return {
      kind: "text",
      text: (value.traceback?.join("\n") ?? `${value.ename ?? ""}: ${value.evalue ?? ""}`).replace(
        ansi,
        "",
      ),
      error: true,
    };
  const data = value.data ?? {};
  for (const type of imageOutputs) {
    const bytes = multiline.safeParse(data[type]);
    if (bytes.success) return { kind: "image", url: `data:${type};base64,${bytes.data.trim()}` };
  }
  // HTML and scripts never render here; their plain-text form stands in.
  const plain = multiline.safeParse(data["text/plain"]);
  return plain.success ? { kind: "text", text: plain.data, error: false } : undefined;
}

/** A Jupyter notebook's cells, or undefined when the text isn't one. */
export function notebookCells(text: string): Notebook | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = NotebookFile.safeParse(json);
  if (!parsed.success) return undefined;
  const metadata = parsed.data.metadata;
  return {
    language: metadata?.language_info?.name ?? metadata?.kernelspec?.language ?? "",
    cells: parsed.data.cells.map((cell) => ({
      kind: cell.cell_type === "markdown" ? "markdown" : cell.cell_type === "code" ? "code" : "raw",
      source: cell.source ?? "",
      outputs: (cell.outputs ?? []).flatMap((raw) => output(raw) ?? []),
    })),
  };
}

/** What makes two cells the same cell: their kind, source and outputs. */
export const cellKey = (cell: NotebookCell) =>
  JSON.stringify([
    cell.kind,
    cell.source,
    cell.outputs.map((out) => (out.kind === "text" ? out.text : out.url)),
  ]);
