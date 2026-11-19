/*
 * A small reader for the XML property lists macOS tools print (`security authorizationdb
 * read`, Info.plist). It keeps the structure (dicts, arrays, strings, numbers, booleans) so a
 * caller can tell which key a value sits under. Anything it can't read is `undefined`, never
 * a guess; value types it doesn't model (`data`, `date`) read as `null`.
 */

export type PlistValue = string | number | boolean | null | PlistValue[] | PlistDict;
export type PlistDict = Map<string, PlistValue>;

interface Token {
  /** A tag name, or undefined for text between tags. */
  tag: string | undefined;
  closing: boolean;
  selfClosing: boolean;
  text: string;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tokens(body: string): Token[] {
  const out: Token[] = [];
  for (const match of body.matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>|([^<]+)/g)) {
    if (match[4] !== undefined) {
      out.push({ tag: undefined, closing: false, selfClosing: false, text: match[4] });
      continue;
    }
    out.push({
      tag: match[2],
      closing: match[1] === "/",
      selfClosing: match[3] === "/",
      text: "",
    });
  }
  return out;
}

class Reader {
  #tokens: Token[];
  #at = 0;
  constructor(list: Token[]) {
    this.#tokens = list;
  }

  /** The next token that isn't whitespace-only text. */
  #next(): Token | undefined {
    for (;;) {
      const token = this.#tokens[this.#at++];
      if (!token || token.tag !== undefined || token.text.trim()) return token;
    }
  }

  get done(): boolean {
    return this.#next() === undefined;
  }

  /** The text up to `</name>`, or undefined when anything else is inside. */
  #text(name: string): string | undefined {
    let text = "";
    for (;;) {
      const token = this.#tokens[this.#at++];
      if (!token) return undefined;
      if (token.tag === undefined) text += token.text;
      else return token.tag === name && token.closing ? decodeXml(text) : undefined;
    }
  }

  value(): PlistValue | undefined {
    const open = this.#next();
    if (!open?.tag || open.closing) return undefined;
    switch (open.tag) {
      case "true":
      case "false":
        if (!open.selfClosing && this.#text(open.tag) !== "") return undefined;
        return open.tag === "true";
      case "string":
        return open.selfClosing ? "" : this.#text("string");
      case "integer":
      case "real": {
        const text = this.#text(open.tag)?.trim();
        const number = text ? Number(text) : Number.NaN;
        return Number.isFinite(number) ? number : undefined;
      }
      case "data":
      case "date":
        return open.selfClosing || this.#text(open.tag) !== undefined ? null : undefined;
      case "array":
        return open.selfClosing ? [] : this.#array();
      case "dict":
        return open.selfClosing ? new Map() : this.#dict();
      default:
        return undefined;
    }
  }

  #array(): PlistValue[] | undefined {
    const items: PlistValue[] = [];
    for (;;) {
      const mark = this.#at;
      const token = this.#next();
      if (!token) return undefined;
      if (token.tag === "array" && token.closing) return items;
      this.#at = mark;
      const item = this.value();
      if (item === undefined) return undefined;
      items.push(item);
    }
  }

  #dict(): PlistDict | undefined {
    const dict: PlistDict = new Map();
    for (;;) {
      const token = this.#next();
      if (!token) return undefined;
      if (token.tag === "dict" && token.closing) return dict;
      if (token.tag !== "key" || token.closing) return undefined;
      const key = token.selfClosing ? "" : this.#text("key");
      if (key === undefined) return undefined;
      const item = this.value();
      if (item === undefined) return undefined;
      dict.set(key.trim(), item);
    }
  }
}

/** The root value of an XML plist, or undefined when the text isn't a well-formed one. */
export function parsePlist(text: string): PlistValue | undefined {
  const open = /<plist\b[^>]*>/.exec(text);
  const end = text.lastIndexOf("</plist>");
  if (!open || end < open.index) return undefined;
  const reader = new Reader(tokens(text.slice(open.index + open[0].length, end)));
  const root = reader.value();
  return root !== undefined && reader.done ? root : undefined;
}

/** A plist root that is a dict, or undefined. */
export function parsePlistDict(text: string): PlistDict | undefined {
  const root = parsePlist(text);
  return root instanceof Map ? root : undefined;
}

/** The strings in a value that is a string or an array (non-strings dropped). */
export function plistStringList(value: PlistValue | undefined): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}
