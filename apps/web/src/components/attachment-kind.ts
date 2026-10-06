import type { Attachment } from "@ace/protocol";
import { formatBytes } from "./format-bytes.ts";

/*
 * What a file is, as its chip and preview show it, decided without I/O from what the daemon
 * classified (`Attachment.kind`, from magic bytes), the MIME type and the extension, in that
 * order. Also the words for how a sent file reached the agent (`Attachment.delivery`).
 */

export type FileKind =
  | "image"
  | "pdf"
  | "code"
  | "text"
  | "sheet"
  | "archive"
  | "audio"
  | "video"
  | "binary";

/** How the preview shows a kind: its own viewer, the first bytes as text, or details only. */
export type PreviewMode = "image" | "pdf" | "text" | "audio" | "video" | "none";

export interface FileFacts {
  name: string;
  mimeType?: string | undefined;
  /** The daemon's classification of the stored bytes, when it has made one. */
  kind?: Attachment["kind"] | undefined;
}

export interface Described {
  kind: FileKind;
  /** "PDF", "TypeScript", "CSV", "ZIP archive", "Audio"… */
  label: string;
  preview: PreviewMode;
}

const languages: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rb: "Ruby",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  hpp: "C++",
  cs: "C#",
  php: "PHP",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  vue: "Vue",
  svelte: "Svelte",
  json: "JSON",
  jsonl: "JSON Lines",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  xml: "XML",
  svg: "SVG",
  lua: "Lua",
  dart: "Dart",
  ex: "Elixir",
  zig: "Zig",
};
const prose: Record<string, string> = {
  md: "Markdown",
  mdx: "MDX",
  txt: "Text",
  log: "Log",
  rst: "reStructuredText",
  ini: "INI",
  env: "Env",
};
const sheets: Record<string, string> = {
  csv: "CSV",
  tsv: "TSV",
  xlsx: "Excel",
  xls: "Excel",
  ods: "Spreadsheet",
  numbers: "Numbers",
};
const archives = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst", "jar"]);
const audio = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus"]);
const video = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi", "ogv"]);

/** A table's own entry, never one inherited from `Object` ("x.constructor" is no language). */
const entry = (table: Record<string, string>, key: string) =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/** The extension, lowercased, without the dot; "" when there is none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The kind, its words and its preview, for a file by its name, MIME type and daemon kind. */
export function describeFile(file: FileFacts): Described {
  const mime = (file.mimeType ?? "").toLowerCase();
  const ext = extensionOf(file.name);
  const upper = ext.toUpperCase();
  if (file.kind === "pdf" || mime === "application/pdf" || (!file.kind && ext === "pdf"))
    return { kind: "pdf", label: "PDF", preview: "pdf" };
  if (file.kind === "image" || (!file.kind && mime.startsWith("image/") && ext !== "svg"))
    return { kind: "image", label: upper || "Image", preview: "image" };
  // Text the daemon validated, or what claims to be text before it has looked.
  const textual =
    file.kind === "text" ||
    (!file.kind &&
      (mime.startsWith("text/") ||
        /json|javascript|typescript|xml|yaml|x-sh/.test(mime) ||
        entry(languages, ext) ||
        entry(prose, ext) ||
        ext === "csv" ||
        ext === "tsv"));
  if (textual) {
    const sheet = ext === "csv" || ext === "tsv" || mime === "text/csv";
    if (sheet) return { kind: "sheet", label: entry(sheets, ext) ?? "CSV", preview: "text" };
    const language = entry(languages, ext);
    if (language) return { kind: "code", label: language, preview: "text" };
    return { kind: "text", label: entry(prose, ext) ?? (upper || "Text"), preview: "text" };
  }
  const sheet = entry(sheets, ext);
  if (sheet || /spreadsheet|ms-excel/.test(mime))
    return { kind: "sheet", label: sheet ?? "Spreadsheet", preview: "none" };
  if (mime.startsWith("audio/") || audio.has(ext))
    return { kind: "audio", label: upper || "Audio", preview: "audio" };
  if (mime.startsWith("video/") || video.has(ext))
    return { kind: "video", label: upper || "Video", preview: "video" };
  if (archives.has(ext) || /zip|x-tar|gzip|compressed|x-7z|x-rar/.test(mime))
    return { kind: "archive", label: `${upper || "Compressed"} archive`, preview: "none" };
  return { kind: "binary", label: upper || "File", preview: "none" };
}

/**
 * A long name split so its middle gives way first: `[head, tail]`, the tail keeping the
 * extension and a few characters before it. Names that fit stay whole (`tail` is "").
 */
export function splitName(name: string, keep = 24): [string, string] {
  if (name.length <= keep) return [name, ""];
  const ext = extensionOf(name);
  const tail = Math.min(name.length - 4, (ext ? ext.length + 1 : 0) + 6);
  return [name.slice(0, name.length - tail), name.slice(name.length - tail)];
}

/** "1.2 MB · PDF": a chip's quiet second part. */
export function fileMeta(file: FileFacts & { bytes?: number | undefined }): string {
  const { label } = describeFile(file);
  return file.bytes === undefined ? label : `${formatBytes(file.bytes)} · ${label}`;
}

type Delivery = NonNullable<Attachment["delivery"]>;

/** How a sent file reached the agent, in a few quiet words under its chip. */
export const deliveryLabels: Record<Delivery, string> = {
  native_image: "native image",
  native_pdf: "native PDF",
  native_resource: "embedded file",
  inline_text: "inline text",
  inline_text_and_path: "inline text, truncated",
  file_path: "sent as file path",
};

/** What the agent received, for the tooltip over a sent file. */
export const deliveryDetails: Record<Delivery, string> = {
  native_image: "The agent received the image itself",
  native_pdf: "The agent received the PDF as a document it reads directly",
  native_resource: "The agent received the file's contents as an embedded resource",
  inline_text: "The file's whole text went into the message",
  inline_text_and_path: "The first 16 KB of text went into the message, with a path to the rest",
  file_path: "The agent received a path to a read-only copy it opens with its own tools",
};

/**
 * A limit as the daemon sets it, in binary units: "512 MB" per file, "1 GB" per message.
 * Sizes stay decimal (`formatBytes`); a limit reads as the round number it was configured as.
 */
export function formatLimit(bytes: number): string {
  const gib = 1024 * 1024 * 1024;
  if (bytes >= gib && bytes % gib === 0) return `${bytes / gib} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
