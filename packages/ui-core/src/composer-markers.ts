import type { ContentPart } from "@ace/protocol";
import type { ComposerToken } from "./composer-tokens.ts";

/*
 * Where a file sits in a message. Adding a file puts a marker in the text at the caret: one
 * U+FFFC (the object replacement character, which nobody types and a paste has taken out) under
 * a token naming the file. The marker shows as the file's chip; on send it leaves the text and
 * becomes the file's offset (`MessageContext.attachments[].at`). Pure.
 */

export const attachmentMarker = "￼";

/** A file's marker token: its chip key in this composer, and its hash once the daemon holds it. */
export interface MarkerFile {
  key: number;
  sha256?: string | undefined;
}

const isMarker = (token: ComposerToken) => token.attachment !== undefined;
const inOrder = (tokens: readonly ComposerToken[]) => tokens.toSorted((a, b) => a.start - b.start);

/** Text as typed or pasted, with any stray marker character taken out. */
export function withoutMarkerCharacters(text: string): string {
  return text.includes(attachmentMarker) ? text.replaceAll(attachmentMarker, "") : text;
}

/** Put a marker for each of `files` at `caret`, in order; the caret ends after them. */
export function insertAttachmentMarkers(
  text: string,
  tokens: readonly ComposerToken[],
  caret: number,
  files: readonly { key: number; name: string }[],
): { text: string; tokens: readonly ComposerToken[]; caret: number } {
  if (!files.length) return { text, tokens, caret };
  const at = Math.max(0, Math.min(caret, text.length));
  const markers = files.map((file, index): ComposerToken => ({
    start: at + index,
    end: at + index + 1,
    label: file.name,
    attachment: { key: file.key },
  }));
  const shifted = tokens.map((token) =>
    token.start >= at
      ? { ...token, start: token.start + files.length, end: token.end + files.length }
      : token,
  );
  return {
    text: text.slice(0, at) + attachmentMarker.repeat(files.length) + text.slice(at),
    tokens: [
      ...shifted.filter((token) => token.end <= at),
      ...markers,
      ...shifted.filter((token) => token.start >= at + files.length),
    ],
    caret: at + files.length,
  };
}

/** The chip keys of the files marked in the text. */
export function markerKeys(tokens: readonly ComposerToken[]): number[] {
  return tokens.flatMap((token) =>
    token.attachment?.key === undefined ? [] : [token.attachment.key],
  );
}

/** Take out the markers `keep` says no to, with their characters. */
function dropMarkers(
  text: string,
  tokens: readonly ComposerToken[],
  keep: (token: ComposerToken) => ComposerToken | undefined,
): { text: string; tokens: readonly ComposerToken[] } {
  let out = "";
  let at = 0;
  let removed = 0;
  let changed = false;
  const kept: ComposerToken[] = [];
  for (const token of inOrder(tokens)) {
    const next = isMarker(token) ? keep(token) : token;
    if (next !== token) changed = true;
    if (next) {
      kept.push(removed ? { ...next, start: next.start - removed, end: next.end - removed } : next);
      continue;
    }
    out += text.slice(at, token.start);
    at = token.end;
    removed += token.end - token.start;
  }
  if (!changed) return { text, tokens };
  return { text: out + text.slice(at), tokens: kept };
}

/** Markers whose file is no longer attached (`attached` holds the chip keys) go. */
export function pruneAttachmentMarkers(
  text: string,
  tokens: readonly ComposerToken[],
  attached: ReadonlySet<number>,
): { text: string; tokens: readonly ComposerToken[] } {
  return dropMarkers(text, tokens, (token) =>
    token.attachment?.key !== undefined && attached.has(token.attachment.key) ? token : undefined,
  );
}

/**
 * A stored or returned draft's markers, tied to the chips this composer made for its files:
 * each by its file's hash. A marker without a file here (one still uploading when the draft was
 * kept) goes.
 */
export function linkAttachmentMarkers(
  text: string,
  tokens: readonly ComposerToken[],
  files: readonly MarkerFile[],
): { text: string; tokens: readonly ComposerToken[] } {
  const taken = new Set<number>();
  return dropMarkers(text, tokens, (token) => {
    const file = files.find(
      (candidate) =>
        !taken.has(candidate.key) &&
        candidate.sha256 !== undefined &&
        candidate.sha256 === token.attachment?.sha256,
    );
    if (!file) return undefined;
    taken.add(file.key);
    return { ...token, attachment: { key: file.key, sha256: file.sha256 } };
  });
}

/** Each marker with its file's hash, where the daemon holds the file, for keeping the draft. */
export function withMarkerHashes(
  tokens: readonly ComposerToken[],
  files: readonly MarkerFile[],
): readonly ComposerToken[] {
  if (!tokens.some(isMarker)) return tokens;
  return tokens.map((token) => {
    const key = token.attachment?.key;
    if (key === undefined) return token;
    const sha256 = files.find((file) => file.key === key)?.sha256;
    return sha256 && sha256 !== token.attachment?.sha256
      ? { ...token, attachment: { key, sha256 } }
      : token;
  });
}

/**
 * The message without its markers, and where each marked file sits: an offset into the
 * message's text parts joined (`MessageContext.attachments[].at`), so a catalog pick's name,
 * which travels as its own part, isn't counted.
 */
export function takeAttachmentMarkers(
  text: string,
  tokens: readonly ComposerToken[],
): {
  text: string;
  tokens: readonly ComposerToken[];
  files: { key: number | undefined; sha256: string | undefined; at: number }[];
} {
  const files: { key: number | undefined; sha256: string | undefined; at: number }[] = [];
  let skipped = 0;
  for (const token of inOrder(tokens)) {
    if (token.catalog) skipped += token.end - token.start;
    if (!token.attachment) continue;
    files.push({
      key: token.attachment.key,
      sha256: token.attachment.sha256,
      at: token.start - files.length - skipped,
    });
  }
  const unmarked = dropMarkers(text, tokens, () => undefined);
  // A marker character without its token (never expected) still never goes out.
  const clean = withoutMarkerCharacters(unmarked.text);
  return { text: clean, tokens: unmarked.text === clean ? unmarked.tokens : [], files };
}

/**
 * A sent message's markers back in its words, for editing it again: each file with an offset
 * (`at`, counted in text parts) gets a marker there, named `name`. Its `key` is set when the
 * composer ties it to the file's chip (`linkAttachmentMarkers`).
 */
export function placeAttachmentMarkers(
  text: string,
  tokens: readonly ComposerToken[],
  files: readonly { sha256: string; at?: number | undefined; name: string }[],
): { text: string; tokens: readonly ComposerToken[] } {
  const placed = files
    .flatMap((file) => (file.at === undefined ? [] : [{ ...file, at: file.at }]))
    .toSorted((a, b) => a.at - b.at);
  if (!placed.length) return { text, tokens };
  let out = "";
  let from = 0;
  let added = 0;
  const next: ComposerToken[] = [];
  const shift = (token: ComposerToken) =>
    added ? { ...token, start: token.start + added, end: token.end + added } : token;
  let remaining = inOrder(tokens);
  const picks = remaining.filter((token) => token.catalog);
  for (const file of placed) {
    // From a text-part offset to one in the composer's text: add the catalog names before it.
    let at = file.at;
    for (const token of picks) if (token.start <= at) at += token.end - token.start;
    at = Math.min(at, text.length);
    for (const token of remaining.filter((kept) => kept.end <= at)) next.push(shift(token));
    remaining = remaining.filter((token) => token.end > at);
    out += text.slice(from, at) + attachmentMarker;
    next.push({
      start: at + added,
      end: at + added + 1,
      label: file.name,
      attachment: { sha256: file.sha256 },
    });
    added++;
    from = at;
  }
  next.push(...remaining.map(shift));
  return { text: out + text.slice(from), tokens: next };
}

/** The joined text of a message's text parts, where file offsets are counted. */
export function textPartsText(input: readonly ContentPart[]): string {
  return input.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * File offsets after a message's words were edited from `before` to `after`: an offset after the
 * edit moves with the words around it; one inside the edited words goes to where they start.
 */
export function shiftAttachmentOffsets<File extends { at?: number | undefined }>(
  before: readonly ContentPart[],
  after: readonly ContentPart[],
  files: readonly File[],
): File[] {
  const was = textPartsText(before);
  const now = textPartsText(after);
  let start = 0;
  while (start < was.length && start < now.length && was[start] === now[start]) start++;
  let end = was.length;
  let nextEnd = now.length;
  while (end > start && nextEnd > start && was[end - 1] === now[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  return files.map((file) => {
    if (file.at === undefined || file.at <= start) return file;
    return { ...file, at: file.at >= end ? file.at + nextEnd - end : start };
  });
}

/** A message's context once its words went from `before` to `after`: its files' offsets follow. */
export function contextAfterEdit<
  Context extends { attachments: readonly { at?: number | undefined }[] },
>(context: Context, before: readonly ContentPart[], after: readonly ContentPart[]): Context {
  if (!context.attachments.some((file) => file.at !== undefined)) return context;
  return { ...context, attachments: shiftAttachmentOffsets(before, after, context.attachments) };
}
