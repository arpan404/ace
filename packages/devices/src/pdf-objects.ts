import { inflateSync } from "node:zlib";

/*
 * Just enough of a PDF reader for the small vector drawings Apple ships with its Simulator
 * device profiles: the objects, their streams (inflated), and a page's size, drawing and
 * resources. Pure: bytes in, values out. Anything it doesn't understand comes back empty.
 */

export type PdfValue =
  | number
  | boolean
  | null
  | PdfName
  | PdfString
  | PdfRef
  | PdfDict
  | PdfValue[];
export interface PdfName {
  kind: "name";
  name: string;
}
export interface PdfString {
  kind: "string";
}
export interface PdfRef {
  kind: "ref";
  id: number;
}
export interface PdfDict {
  kind: "dict";
  entries: Map<string, PdfValue>;
  /** The stream that follows the dictionary, still encoded. */
  stream?: Uint8Array;
}

const delimiters = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);
const isSpace = (char: string | undefined) =>
  char === " " || char === "\n" || char === "\r" || char === "\t" || char === "\f" || char === "\0";

/** Reads PDF syntax (values and bare keywords) from text, one token at a time. */
export class PdfLexer {
  position: number;
  private readonly text: string;
  constructor(text: string, position = 0) {
    this.text = text;
    this.position = position;
  }
  private skip(): void {
    const { text } = this;
    while (this.position < text.length) {
      const char = text[this.position];
      if (isSpace(char)) this.position++;
      else if (char === "%") {
        while (this.position < text.length && text[this.position] !== "\n") this.position++;
      } else return;
    }
  }
  /** The next value, or the next bare keyword as `{ keyword }`, or undefined at the end. */
  next(): PdfValue | { keyword: string } | undefined {
    this.skip();
    const { text } = this;
    if (this.position >= text.length) return undefined;
    const char = text[this.position];
    if (char === "/") {
      let end = this.position + 1;
      while (end < text.length && !isSpace(text[end]) && !delimiters.has(text[end] ?? "")) end++;
      const name = text.slice(this.position + 1, end);
      this.position = end;
      return { kind: "name", name };
    }
    if (char === "(") {
      let depth = 0;
      while (this.position < text.length) {
        const current = text[this.position++];
        if (current === "\\") this.position++;
        else if (current === "(") depth++;
        else if (current === ")" && --depth === 0) break;
      }
      return { kind: "string" };
    }
    if (char === "<" && text[this.position + 1] === "<") {
      this.position += 2;
      const entries = new Map<string, PdfValue>();
      for (;;) {
        this.skip();
        if (this.position >= text.length) break;
        if (text.startsWith(">>", this.position)) {
          this.position += 2;
          break;
        }
        const key = this.value();
        const value = this.value();
        if (key && typeof key === "object" && "kind" in key && key.kind === "name")
          entries.set(key.name, value ?? null);
        else if (key === undefined) break;
      }
      return { kind: "dict", entries };
    }
    if (char === "<") {
      const end = text.indexOf(">", this.position);
      this.position = end < 0 ? text.length : end + 1;
      return { kind: "string" };
    }
    if (char === "[") {
      this.position++;
      const items: PdfValue[] = [];
      for (;;) {
        this.skip();
        if (this.position >= text.length) break;
        if (text[this.position] === "]") {
          this.position++;
          break;
        }
        const item = this.value();
        if (item === undefined) break;
        items.push(item);
      }
      return items;
    }
    if (char === "]" || char === ">" || char === ")" || char === "{" || char === "}") {
      this.position++;
      return { keyword: char };
    }
    let end = this.position;
    while (end < text.length && !isSpace(text[end]) && !delimiters.has(text[end] ?? "")) end++;
    const word = text.slice(this.position, end);
    this.position = end;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      const number = Number(word);
      // "12 0 R" is a reference; look ahead without consuming anything else.
      const save = this.position;
      const generation = /^\s+(\d+)\s+R(?![^\s/[\]<>()%])/.exec(text.slice(save, save + 24));
      if (generation && Number.isInteger(number)) {
        this.position = save + generation[0].length;
        return { kind: "ref", id: number };
      }
      return number;
    }
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return { keyword: word };
  }
  /** The next value; a keyword where a value belongs reads as null. */
  value(): PdfValue | undefined {
    const token = this.next();
    if (token === undefined) return undefined;
    return isKeyword(token) ? null : token;
  }
}

export function isKeyword(token: PdfValue | { keyword: string }): token is { keyword: string } {
  return token !== null && typeof token === "object" && "keyword" in token;
}

/** A PDF's numbered objects. Streams keep their encoded bytes until `streamBytes`. */
export function pdfObjects(bytes: Uint8Array): Map<number, PdfValue> {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const objects = new Map<number, PdfValue>();
  const header = /(\d+)\s+\d+\s+obj\b/g;
  for (let match = header.exec(text); match; match = header.exec(text)) {
    const lexer = new PdfLexer(text, match.index + match[0].length);
    const value = lexer.value();
    if (value === undefined) continue;
    const after = /^\s*stream\r?\n/.exec(text.slice(lexer.position, lexer.position + 16));
    if (after && isDict(value)) {
      const start = lexer.position + after[0].length;
      const end = text.indexOf("endstream", start);
      if (end > start) {
        let stop = end;
        if (text[stop - 1] === "\n") stop--;
        if (text[stop - 1] === "\r") stop--;
        value.stream = bytes.subarray(start, stop);
        header.lastIndex = end;
      }
    }
    objects.set(Number(match[1]), value);
  }
  return objects;
}

export function isDict(value: PdfValue | undefined): value is PdfDict {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value) && value.kind === "dict"
  );
}

/** Follows a reference to its object; anything else is returned as it is. */
export function resolve(objects: Map<number, PdfValue>, value: PdfValue | undefined) {
  let current = value;
  for (let hops = 0; hops < 8; hops++) {
    if (current !== null && typeof current === "object" && !Array.isArray(current))
      if (current.kind === "ref") {
        current = objects.get(current.id);
        continue;
      }
    return current;
  }
  return undefined;
}

export function nameOf(value: PdfValue | undefined): string | undefined {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.kind === "name"
    ? value.name
    : undefined;
}

export function numbersOf(value: PdfValue | undefined): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
}

/** A stream's decoded bytes: unfiltered or Flate only; undefined for any other filter. */
export function streamBytes(dict: PdfDict): Uint8Array | undefined {
  if (!dict.stream) return undefined;
  const filter = dict.entries.get("Filter");
  const filters = Array.isArray(filter) ? filter.map(nameOf) : filter ? [nameOf(filter)] : [];
  let data: Uint8Array = dict.stream;
  for (const name of filters) {
    if (name !== "FlateDecode") return undefined;
    try {
      data = inflateSync(data);
    } catch {
      return undefined;
    }
  }
  return data;
}

export interface PdfPage {
  /** [x0, y0, x1, y1] in PDF units. */
  box: [number, number, number, number];
  content: string;
  resources: PdfDict | undefined;
  objects: Map<number, PdfValue>;
}

/** A stream's decoded drawing as text, or "" when it can't be decoded. */
export function streamText(dict: PdfDict): string {
  const data = streamBytes(dict);
  return data ? Buffer.from(data).toString("latin1") : "";
}

/** The first page: its size, drawing and resources (inherited from its parents when absent). */
export function firstPage(bytes: Uint8Array): PdfPage | undefined {
  const objects = pdfObjects(bytes);
  const page = [...objects.values()].find(
    (value): value is PdfDict => isDict(value) && nameOf(value.entries.get("Type")) === "Page",
  );
  if (!page) return undefined;
  const inherited = (key: string) => {
    let node: PdfDict | undefined = page;
    for (let depth = 0; node && depth < 16; depth++) {
      const value = node.entries.get(key);
      if (value !== undefined) return resolve(objects, value);
      const parent = resolve(objects, node.entries.get("Parent"));
      node = isDict(parent) ? parent : undefined;
    }
    return undefined;
  };
  const box = numbersOf(inherited("MediaBox"));
  if (box.length !== 4) return undefined;
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = box;
  if (!(x1 > x0 && y1 > y0)) return undefined;
  const contents = resolve(objects, page.entries.get("Contents"));
  const parts = Array.isArray(contents)
    ? contents.map((part) => resolve(objects, part))
    : [contents];
  const content = parts.filter(isDict).map(streamText).join("\n");
  const resources = inherited("Resources");
  return {
    box: [x0, y0, x1, y1],
    content,
    resources: isDict(resources) ? resources : undefined,
    objects,
  };
}
