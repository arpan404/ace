/*
 * How a bot's words split into chat messages (ADR 0212): `<msg>` is one bubble, `reply="m7"`
 * quotes an earlier message, `<doc title="…">` is long content for a document card. Lenient and
 * never losing text: words outside tags are a message of their own, an unclosed tag closes at the
 * end, nesting or a stray close falls back to plain words, and nothing inside code counts.
 *
 * The same parser lives in Rust (`spade_core::chat_markup`); both run the table in
 * `spade/docs/chat-markup.cases.json`.
 */

export interface SpadeChatSegment {
  kind: "msg" | "doc" | "react";
  text: string;
  /** The earlier message it quotes, as an id (`m12`, `m12.3`). */
  reply?: string;
  /** A reaction's target message, as an id; the emoji is its `text`. */
  to?: string;
  /** A document's title. */
  title?: string;
  /** Still arriving: its closing tag hasn't come yet (live text only). */
  open?: boolean;
}

/** The most messages and documents one model step's text makes; the rest join the last. */
export const spadeMostMessages = 12;
export const spadeMostDocuments = 3;
const mostTitle = 120;
const replyId = /^m\d+(\.\d+)?$/;

/** Finished words as messages: a tag cut at the end is words. */
export function spadeChatSegments(text: string): SpadeChatSegment[] {
  return segments(text, false).filter((segment) => segment.kind !== "react");
}

/** Words still streaming: a tag still arriving at the end is held back, never drawn. */
export function spadeLiveChatSegments(text: string): SpadeChatSegment[] {
  return segments(text, true).filter((segment) => segment.kind !== "react");
}

/** Messages, documents and reactions together, in order (the shared table's view). */
export function spadeChatParts(text: string, live = false): SpadeChatSegment[] {
  return segments(text, live);
}

/** The reactions a bot's finished words make: `<react to="m12">👍</react>`. */
export function spadeChatReactions(text: string): { to: string; emoji: string }[] {
  return segments(text, false).flatMap((segment) =>
    segment.kind === "react" && segment.to ? [{ to: segment.to, emoji: segment.text }] : [],
  );
}

/** The words with the markup removed, for places they go as plain text (speech, a copy). */
export function spadePlainChat(text: string): string {
  return spadeChatSegments(text)
    .map((segment) => (segment.title ? `${segment.title}\n\n${segment.text}` : segment.text))
    .join("\n\n");
}

/** A message's id from its event's `seq` and its place in that event's words (ADR 0212 §3). */
export function spadeMessageId(seq: number, index = 0): string {
  return index === 0 ? `m${seq}` : `m${seq}.${index + 1}`;
}

type Kind = "msg" | "doc";
type Token =
  | { type: "text"; text: string }
  | { type: "open"; kind: Kind; attrs: Map<string, string> }
  | { type: "close"; kind: Kind }
  /** A whole reaction on one line: `<react to="m12">👍</react>`. */
  | { type: "react"; attrs: Map<string, string>; emoji: string };

function segments(text: string, live: boolean): SpadeChatSegment[] {
  const { tokens } = tokenize(text, live);
  const out: SpadeChatSegment[] = [];
  let open: { kind: Kind; attrs: Map<string, string>; text: string } | undefined;
  let malformed = false;
  // A reaction inside a message comes out before it.
  const held: SpadeChatSegment[] = [];
  const reactions: SpadeChatSegment[] = [];
  tokens.forEach((token, at) => {
    if (token.type === "react") {
      const to = token.attrs.get("to")?.trim();
      const reaction: SpadeChatSegment = {
        kind: "react",
        text: token.emoji.trim(),
        ...(to && replyId.test(to) ? { to } : {}),
      };
      reactions.push(reaction);
      if (open) held.push(reaction);
      else out.push(reaction);
    } else if (token.type === "text") {
      if (open) open.text += token.text;
      else
        out.push({
          kind: "msg",
          text: token.text,
          ...(live && at === tokens.length - 1 ? { open: true } : {}),
        });
    } else if (token.type === "open") {
      if (open) malformed = true;
      else open = { kind: token.kind, attrs: token.attrs, text: "" };
    } else {
      if (open?.kind !== token.kind) malformed = true;
      else {
        out.push(...held.splice(0), segmentOf(open, false));
        open = undefined;
      }
    }
  });
  if (open) out.push(...held.splice(0), segmentOf(open, live));
  if (malformed) {
    const words = tokens
      .flatMap((token) => (token.type === "text" ? [token.text.trim()] : []))
      .filter(Boolean)
      .join("\n\n");
    const message: SpadeChatSegment[] = words
      ? [{ kind: "msg", text: words, ...(live ? { open: true } : {}) }]
      : [];
    return [...message, ...reactions.filter(validReaction)];
  }
  // Each segment is this call's own: trimmed in place.
  for (const segment of out) segment.text = segment.text.trim();
  return capped(
    out.filter((segment) =>
      segment.kind === "react" ? validReaction(segment) : segment.text !== "",
    ),
  );
}

function segmentOf(
  open: { kind: Kind; attrs: Map<string, string>; text: string },
  stillOpen: boolean,
): SpadeChatSegment {
  const reply = open.attrs.get("reply")?.trim();
  const title = open.kind === "doc" ? [...(open.attrs.get("title")?.trim() ?? "")] : [];
  return {
    kind: open.kind,
    text: open.text,
    ...(open.kind === "msg" && reply && replyId.test(reply) ? { reply } : {}),
    ...(title.length ? { title: title.slice(0, mostTitle).join("") } : {}),
    ...(stillOpen ? { open: true } : {}),
  };
}

/** A reaction names a message by id and has an emoji. */
const validReaction = (segment: SpadeChatSegment) =>
  segment.to !== undefined && segment.text !== "";

/** Messages past twelve join the twelfth; documents past three join the third under a heading. */
function capped(list: SpadeChatSegment[]): SpadeChatSegment[] {
  const out: SpadeChatSegment[] = [];
  let messages = -1;
  let documents = -1;
  let seenMessages = 0;
  let seenDocuments = 0;
  for (const segment of list) {
    if (segment.kind === "react") {
      out.push(segment);
    } else if (segment.kind === "msg") {
      seenMessages++;
      if (seenMessages > spadeMostMessages) {
        out[messages] = join(out[messages], segment.text, segment.open);
        continue;
      }
      out.push(segment);
      messages = out.length - 1;
    } else {
      seenDocuments++;
      if (seenDocuments > spadeMostDocuments) {
        const words = segment.title ? `## ${segment.title}\n\n${segment.text}` : segment.text;
        out[documents] = join(out[documents], words, segment.open);
        continue;
      }
      out.push(segment);
      documents = out.length - 1;
    }
  }
  return out;
}

function join(
  into: SpadeChatSegment | undefined,
  text: string,
  open: boolean | undefined,
): SpadeChatSegment {
  const base = into ?? { kind: "msg", text: "" };
  return { ...base, text: `${base.text}\n\n${text}`, ...(open ? { open: true } : {}) };
}

/**
 * The words as text and tags. `cut`: live text ended inside a tag, which is held back, so the
 * words before it are not the open end.
 */
function tokenize(text: string, live: boolean): { tokens: Token[]; cut: boolean } {
  const tokens: Token[] = [];
  let words = "";
  let at = 0;
  let lineStart = true;
  let fence: { char: string; length: number } | undefined;
  const flush = () => {
    if (words) tokens.push({ type: "text", text: words });
    words = "";
  };
  while (at < text.length) {
    if (lineStart) {
      const run = fenceRun(text, at);
      if (run && !fence) {
        fence = { char: run.char, length: run.length };
        const end = lineEnd(text, at);
        words += text.slice(at, end);
        at = end;
        continue;
      }
      if (run && fence && run.char === fence.char && run.length >= fence.length) {
        fence = undefined;
        words += text.slice(at, run.end);
        at = run.end;
        lineStart = false;
        continue;
      }
    }
    if (fence) {
      const end = lineEnd(text, at);
      words += text.slice(at, end);
      at = end;
      lineStart = true;
      continue;
    }
    const char = text[at] ?? "";
    if (char === "\n") {
      words += char;
      at++;
      lineStart = true;
      continue;
    }
    if (char === "`") {
      const end = codeSpanEnd(text, at);
      words += text.slice(at, end);
      at = end;
      lineStart = false;
      continue;
    }
    if (char === "<") {
      const tag = readTag(text, at);
      if (tag === "partial" && live) {
        flush();
        return { tokens, cut: true };
      }
      if (tag && tag !== "partial") {
        flush();
        tokens.push(tag.token);
        at = tag.end;
        continue;
      }
    }
    words += char;
    at++;
    lineStart = false;
  }
  flush();
  return { tokens, cut: false };
}

/** Past the end of the line at `at`, its newline included. */
function lineEnd(text: string, at: number): number {
  const newline = text.indexOf("\n", at);
  return newline < 0 ? text.length : newline + 1;
}

/** A fence (three or more backticks or tildes, up to three spaces in) starting at `at`. */
function fenceRun(text: string, at: number) {
  let start = at;
  while (start - at < 3 && text[start] === " ") start++;
  const char = text[start];
  if (char !== "`" && char !== "~") return undefined;
  let end = start;
  while (text[end] === char) end++;
  return end - start >= 3 ? { char, length: end - start, end } : undefined;
}

/** Past an inline code span opening at `at`, or past its backticks alone when none closes it. */
function codeSpanEnd(text: string, at: number): number {
  let open = at;
  while (text[open] === "`") open++;
  const length = open - at;
  const line = lineEnd(text, open);
  let from = open;
  while (from < line) {
    const next = text.indexOf("`", from);
    if (next < 0 || next >= line) break;
    let end = next;
    while (text[end] === "`") end++;
    if (end - next === length) return end;
    from = end;
  }
  return open;
}

const tagNames = ["msg", "doc"] as const;

/** A tag at `at`, `partial` when the text ends inside one, or nothing when it is words. */
function readTag(text: string, at: number): { token: Token; end: number } | "partial" | undefined {
  const reaction = readReaction(text, at);
  if (reaction !== null) return reaction;
  if (text[at + 1] === "/") {
    for (const kind of tagNames) {
      const close = `</${kind}>`;
      if (text.startsWith(close, at))
        return { token: { type: "close", kind }, end: at + close.length };
      const rest = text.slice(at);
      if (rest.length < close.length && close.startsWith(rest)) return "partial";
    }
    return undefined;
  }
  for (const kind of tagNames) {
    const name = `<${kind}`;
    const rest = text.slice(at, at + name.length);
    if (at + rest.length === text.length && name.startsWith(rest) && rest.length < name.length + 1)
      return "partial";
    if (!text.startsWith(name, at)) continue;
    const next = text[at + name.length];
    if (next === ">")
      return { token: { type: "open", kind, attrs: new Map() }, end: at + name.length + 1 };
    if (next !== " " && next !== "\t") return undefined;
    const attrs = readAttrs(text, at + name.length);
    if (attrs === "partial" || attrs === undefined) return attrs;
    return { token: { type: "open", kind, attrs: attrs.attrs }, end: attrs.end };
  }
  return undefined;
}

/** A whole reaction at `at`; null when the text there is no `<react`, so other tags are tried. */
function readReaction(
  text: string,
  at: number,
): { token: Token; end: number } | "partial" | undefined | null {
  const rest = text.slice(at, at + 6);
  if (at + rest.length === text.length && "<react".startsWith(rest)) return "partial";
  if (!text.startsWith("<react", at)) return null;
  const next = text[at + 6];
  let attrs = new Map<string, string>();
  let from = at + 7;
  if (next === " " || next === "\t") {
    const read = readAttrs(text, at + 6);
    if (read === "partial" || read === undefined) return read;
    attrs = read.attrs;
    from = read.end;
  } else if (next !== ">") return next === undefined ? "partial" : null;
  const close = text.indexOf("</react>", from);
  const newline = text.indexOf("\n", from);
  if (close < 0) return newline < 0 ? "partial" : undefined;
  if (newline >= 0 && newline < close) return undefined;
  return { token: { type: "react", attrs, emoji: text.slice(from, close) }, end: close + 8 };
}

/** Where an unquoted attribute name or value stops. */
const stop = (char: string | undefined) =>
  char === undefined || char === " " || char === "\t" || char === ">" || char === "\n";

/** A tag's attributes from `at` to its `>`: on one line, quoted or not. */
function readAttrs(
  text: string,
  at: number,
): { attrs: Map<string, string>; end: number } | "partial" | undefined {
  const attrs = new Map<string, string>();
  let i = at;
  while (i < text.length) {
    const char = text[i];
    if (char === "\n") return undefined;
    if (char === ">") return { attrs, end: i + 1 };
    if (char === " " || char === "\t") {
      i++;
      continue;
    }
    let name = "";
    while (i < text.length && !stop(text[i]) && text[i] !== "=") name += text[i++];
    if (text[i] !== "=") {
      if (!name) i++;
      continue;
    }
    i++;
    const quote = text[i];
    let value = "";
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, i + 1);
      const newline = text.indexOf("\n", i + 1);
      if (close < 0) return newline < 0 ? "partial" : undefined;
      if (newline >= 0 && newline < close) return undefined;
      value = text.slice(i + 1, close);
      i = close + 1;
    } else {
      while (i < text.length && !stop(text[i])) value += text[i++];
    }
    if (name) attrs.set(name, value);
  }
  return "partial";
}
