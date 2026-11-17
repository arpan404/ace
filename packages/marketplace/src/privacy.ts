import { secretSpans } from "./secrets.ts";

/*
 * The privacy pass over text that will be published (ADR 0174 §2): what in it is about the
 * person or their machine rather than the thing they made. Home-folder paths, email addresses,
 * phone numbers, addresses on a private network, the person's own name and username, and
 * anything shaped like a secret. Each finding is a span the person sees, then edits out or
 * confirms; a secret is never confirmable. Pure.
 */

export type PrivacyKind = "secret" | "home-path" | "email" | "phone" | "private-url" | "own-name";

export interface PrivacySpan {
  start: number;
  end: number;
  kind: PrivacyKind;
  text: string;
}

export interface PrivacyContext {
  /** The person's own name, username and the like: each is flagged where it appears whole. */
  names: readonly string[];
}

/** What a kind of finding is, as the person reads it. */
export const privacyWords: Readonly<Record<PrivacyKind, string>> = {
  secret: "looks like a key, token or password",
  "home-path": "is a folder on your computer",
  email: "is an email address",
  phone: "is a phone number",
  "private-url": "is an address on a private network",
  "own-name": "is your name",
};

const trailing = /[.,;:!?'")\]]+$/;
const homePaths = [
  /(?<![\w/])\/(?:Users|home)\/[^\s'"`<>()]+/g,
  /(?<![\w])[A-Za-z]:\\Users\\[^\s'"`<>()]+/g,
];
const email = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const phone =
  /(?<![\w.+])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{2,4}(?:[ .-]\d{2,4}){1,3}(?![\w.])/g;
const url = /\b(?:https?|wss?|ftp):\/\/[^\s<>"'`]+/gi;
const ipv4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;
const privateSuffixes = [
  ".local",
  ".lan",
  ".internal",
  ".home.arpa",
  ".corp",
  ".intranet",
  ".localdomain",
];

function privateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part > 255))
    return false;
  const [a = 0, b = 0] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

function privateHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (privateSuffixes.some((suffix) => name.endsWith(suffix))) return true;
  if (privateIpv4(name)) return true;
  if (name === "::1" || /^f[cd][0-9a-f]{2}:/.test(name) || name.startsWith("fe80:")) return true;
  // A single-label host (`http://nas/`) only resolves on the person's own network.
  return !name.includes(".") && !name.includes(":");
}

function hostOf(address: string): string | undefined {
  try {
    return new URL(address).hostname;
  } catch {
    return undefined;
  }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every finding in `text`, in order, none overlapping (the earliest and longest is kept). */
export function privacySpans(text: string, context: PrivacyContext): PrivacySpan[] {
  const found: PrivacySpan[] = [];
  const add = (start: number, matched: string, kind: PrivacyKind, trim = true) => {
    const kept = trim ? matched.replace(trailing, "") : matched;
    if (kept) found.push({ start, end: start + kept.length, kind, text: kept });
  };
  for (const span of secretSpans(text))
    add(span.start, text.slice(span.start, span.end), "secret", false);
  for (const pattern of homePaths)
    for (const match of text.matchAll(pattern)) add(match.index, match[0], "home-path");
  for (const match of text.matchAll(email)) add(match.index, match[0], "email");
  for (const match of text.matchAll(url)) {
    const address = match[0].replace(trailing, "");
    const host = hostOf(address);
    if (host !== undefined && privateHost(host)) add(match.index, address, "private-url");
  }
  for (const match of text.matchAll(ipv4))
    if (privateIpv4(match[0])) add(match.index, match[0], "private-url");
  for (const match of text.matchAll(phone)) {
    const digits = match[0].replace(/\D/g, "").length;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(match[0]);
    if (digits >= 7 && digits <= 15 && !date) add(match.index, match[0], "phone", false);
  }
  for (const name of new Set(
    context.names.map((each) => each.trim()).filter((each) => each.length >= 3),
  ))
    for (const match of text.matchAll(
      new RegExp(`(?<![\\p{L}\\p{N}_])${escape(name)}(?![\\p{L}\\p{N}_])`, "giu"),
    ))
      add(match.index, match[0], "own-name", false);
  // Earliest first; at one start the longest; a secret wins a tie.
  found.sort((a, b) => a.start - b.start || b.end - a.end || (a.kind === "secret" ? -1 : 1));
  const kept: PrivacySpan[] = [];
  for (const span of found) {
    const last = kept.at(-1);
    if (!last || span.start >= last.end) kept.push(span);
    else if (span.kind === "secret" && last.kind !== "secret") kept[kept.length - 1] = span;
  }
  return kept;
}

/** A flagged text, shortened past 80 characters, in quotes. */
export const privacyQuote = (text: string) =>
  `"${text.length > 80 ? `${text.slice(0, 77)}…` : text}"`;

/** Each span with the sentence the person reads for it. */
export function withSentences(
  spans: readonly PrivacySpan[],
): (PrivacySpan & { sentence: string })[] {
  return spans.map((span) => ({
    ...span,
    sentence:
      span.kind === "secret"
        ? `Something here ${privacyWords.secret}. Take it out before publishing.`
        : `${privacyQuote(span.text)} ${privacyWords[span.kind]}.`,
  }));
}
