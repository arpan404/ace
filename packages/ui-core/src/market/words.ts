/*
 * The marketplace's plain words, pure: sentences, counts, lists, sizes and dates, as the web's
 * marketplace and the phone's both write them (ADR 0168 §12).
 */

/** Ends text with a full stop unless it already ends a sentence. */
export const sentence = (text: string): string => {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/** "3:04 PM", or "Nov 14, 3:04 PM" on another day: when the listings were last read. */
export function readAtText(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  if (new Date(at).toDateString() === new Date(now).toDateString()) return time;
  const day = new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

/** "Nov 14, 2026": the day a version was published. */
export const dateText = (at: number): string =>
  new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** A size in words: "812 bytes", "4.2 KB", "1.3 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * What a flagged file in a review is, in a word: the market flags every executable and every file
 * that isn't a text format, and a font or a picture is no program. Undefined when unflagged.
 */
export function flaggedWord(file: {
  path: string;
  executable: boolean;
  flagged: boolean;
}): string | undefined {
  if (file.executable) return "A script or program";
  if (!file.flagged) return undefined;
  const extension = file.path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (["woff2", "woff", "ttf", "otf"].includes(extension)) return "Font";
  if (["webp", "png", "jpg", "jpeg", "gif", "avif"].includes(extension)) return "Picture";
  if (["mp4", "m4v", "mov", "webm"].includes(extension)) return "Video";
  if (["js", "mjs", "cjs", "ts", "py", "sh", "rb", "wasm"].includes(extension)) return "Code";
  return "Not text";
}

/** "1 file", "12 files". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "A", "A and B", "A, B and C". */
export function andList(words: readonly string[]): string {
  if (words.length < 2) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
