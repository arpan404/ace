import type {
  BrowserAnnotation,
  BrowserAnnotationBox,
  BrowserAnnotationStyleChange,
  BrowserAnnotationTextChange,
  BrowserAnnotationViewport,
  ContentPart,
} from "@ace/protocol";
import { browserAnnotationsClose, browserAnnotationsOpen } from "./browser-annotation-prompt.ts";
import type { DraftAnnotations } from "./composer-drafts.ts";

/*
 * Reading a sent `<browser_annotations version="1">` block back (ADR 0082): for the transcript's
 * card and for Edit on a failed message. Lenient: a block this version can't read stays text.
 */

/** An element a region names: its tag, page text excerpt and selector. */
export interface ParsedRegionElement {
  tag: string;
  text: string;
  selector: string;
}

export interface ParsedBrowserAnnotation {
  number: number;
  kind: "element" | "region";
  url: string;
  title: string;
  tag: string;
  /** The quoted page text (already an excerpt). */
  text: string;
  selector: string;
  xpath: string;
  box?: BrowserAnnotationBox | undefined;
  comment: string;
  styles: BrowserAnnotationStyleChange[];
  textChange?: BrowserAnnotationTextChange | undefined;
  viewport?: BrowserAnnotationViewport | undefined;
  /** A region's elements; for a region `tag` and `selector` are the element holding it. */
  elements?: ParsedRegionElement[] | undefined;
}

export type ParsedAnnotationImage =
  | { kind: "page"; url: string }
  | { kind: "crop"; number: number };

export interface ParsedBrowserAnnotations {
  items: ParsedBrowserAnnotation[];
  images: ParsedAnnotationImage[];
}

const blockPattern = /<browser_annotations version="1"[^>\n]*>[\s\S]*?<\/browser_annotations>/;

/** The person's text without the block, and the block itself when there is one. */
export function splitBrowserAnnotations(text: string): { text: string; block?: string } {
  const match = blockPattern.exec(text);
  if (!match) return { text };
  const rest = (
    text.slice(0, match.index).trimEnd() + text.slice(match.index + match[0].length)
  ).replace(/\s+$/, "");
  return { text: rest, block: match[0] };
}

function json(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const viewportLine =
  /^Viewport: (-?[\d.]+)×(-?[\d.]+) CSS px, device pixel ratio ([\d.]+), scrolled to x=(-?[\d.]+) y=(-?[\d.]+)$/;
const boxLine = /^Box: x=(-?[\d.]+) y=(-?[\d.]+) width=([\d.]+) height=([\d.]+)/;
const itemLine = /^\[(\d{1,2})\] <([a-z0-9-]+)>(?: (".*"))?$/;
const textChangeLine = /^Text change: (".*") → (".*")$/;
const regionLine =
  /^\[(\d{1,2})\] Region (-?[\d.]+),(-?[\d.]+) ([\d.]+)×([\d.]+)(?: containing: .*)?$/;
const insideLine = /^Inside: <([a-z0-9-]+)> (.*)$/;
const regionElementLine = /^<([a-z0-9-]+)>(?: ("(?:[^"\\]|\\.)*"))?(?: at (.*))?$/;

/** The block's annotations and images, or undefined when it isn't a version 1 block. */
export function parseBrowserAnnotations(block: string): ParsedBrowserAnnotations | undefined {
  const lines = block.split("\n");
  if (!lines[0]?.startsWith(browserAnnotationsOpen) || lines.at(-1) !== browserAnnotationsClose)
    return undefined;
  const items: ParsedBrowserAnnotation[] = [];
  const images: ParsedAnnotationImage[] = [];
  let page: { url: string; title: string; viewport?: BrowserAnnotationViewport } | undefined;
  let item: ParsedBrowserAnnotation | undefined;
  let mode: "comment" | "styles" | "elements" | "images" | undefined;
  for (const line of lines.slice(1, -1)) {
    if (line.startsWith("  ") && mode) {
      const body = line.slice(2);
      if (mode === "comment" && item) item.comment += `\n${body}`;
      else if (mode === "elements" && item) {
        const match = regionElementLine.exec(body);
        if (match)
          (item.elements ??= []).push({
            tag: match[1] ?? "element",
            text: match[2] ? (json(match[2]) ?? "") : "",
            selector: match[3] ?? "",
          });
      } else if (mode === "styles" && item) {
        const [property = "", values = ""] = splitOnce(body, ": ");
        const [before = "", after = ""] = splitOnce(values, " → ");
        if (property) item.styles.push({ property, before, after });
      } else if (mode === "images") {
        const caption = body.replace(/^\d+\. /, "");
        const crop = /^Crop of \[(\d{1,2})\]$/.exec(caption);
        const shot = /^Screenshot of (.+) with markers? [\d–, ]+$/.exec(caption);
        if (crop) images.push({ kind: "crop", number: Number(crop[1]) });
        else if (shot?.[1]) images.push({ kind: "page", url: shot[1] });
      }
      continue;
    }
    mode = undefined;
    if (line.startsWith("Page: ")) {
      page = { url: line.slice(6), title: "" };
      item = undefined;
    } else if (line.startsWith("Title: ") && page && !item) page.title = line.slice(7);
    else if (line.startsWith("Viewport: ") && page && !item) {
      const match = viewportLine.exec(line);
      if (match)
        page.viewport = {
          width: Number(match[1]),
          height: Number(match[2]),
          devicePixelRatio: Number(match[3]),
          scrollX: Number(match[4]),
          scrollY: Number(match[5]),
        };
    } else if (itemLine.test(line) && page) {
      const match = itemLine.exec(line);
      item = {
        number: Number(match?.[1]),
        url: page.url,
        title: page.title,
        kind: "element",
        tag: match?.[2] ?? "element",
        text: match?.[3] ? (json(match[3]) ?? "") : "",
        selector: "",
        xpath: "",
        comment: "",
        styles: [],
        viewport: page.viewport,
      };
      items.push(item);
    } else if (regionLine.test(line) && page) {
      const match = regionLine.exec(line);
      item = {
        number: Number(match?.[1]),
        kind: "region",
        url: page.url,
        title: page.title,
        tag: "body",
        text: "",
        selector: "",
        xpath: "",
        box: {
          x: Number(match?.[2]),
          y: Number(match?.[3]),
          width: Number(match?.[4]),
          height: Number(match?.[5]),
        },
        comment: "",
        styles: [],
        viewport: page.viewport,
        elements: [],
      };
      items.push(item);
    } else if (item && line.startsWith("Inside: ")) {
      const match = insideLine.exec(line);
      if (match) [item.tag, item.selector] = [match[1] ?? "body", match[2] ?? ""];
    } else if (item && line === "Elements:") mode = "elements";
    else if (item && line.startsWith("Selector: ")) item.selector = line.slice(10);
    else if (item && line.startsWith("XPath: ")) item.xpath = line.slice(7);
    else if (item && line.startsWith("Box: ")) {
      const match = boxLine.exec(line);
      if (match)
        item.box = {
          x: Number(match[1]),
          y: Number(match[2]),
          width: Number(match[3]),
          height: Number(match[4]),
        };
    } else if (item && line.startsWith("Comment: ")) {
      item.comment = line.slice(9);
      mode = "comment";
    } else if (item && line === "Style changes:") mode = "styles";
    else if (item && line.startsWith("Text change: ")) {
      const match = textChangeLine.exec(line);
      const before = match?.[1] ? json(match[1]) : undefined;
      const after = match?.[2] ? json(match[2]) : undefined;
      if (before !== undefined && after !== undefined) item.textChange = { before, after };
    } else if (line.startsWith("Images: ")) {
      item = undefined;
      mode = "images";
    }
  }
  return items.length ? { items, images } : undefined;
}

function splitOnce(value: string, separator: string): [string, string] {
  const at = value.indexOf(separator);
  return at < 0 ? [value, ""] : [value.slice(0, at), value.slice(at + separator.length)];
}

/** A message's parts without the block (empty text parts it leaves are dropped), and the block. */
export function splitAnnotationParts(parts: readonly ContentPart[]): {
  parts: ContentPart[];
  annotations?: ParsedBrowserAnnotations | undefined;
} {
  let annotations: ParsedBrowserAnnotations | undefined;
  const kept: ContentPart[] = [];
  for (const part of parts) {
    if (part.type !== "text" || annotations) {
      kept.push(part);
      continue;
    }
    const split = splitBrowserAnnotations(part.text);
    const parsed = split.block ? parseBrowserAnnotations(split.block) : undefined;
    if (!parsed) {
      kept.push(part);
      continue;
    }
    annotations = parsed;
    if (split.text.trim()) kept.push({ ...part, text: split.text });
  }
  if (!kept.length && annotations) kept.push({ type: "text", text: "" });
  return { parts: kept, annotations };
}

/**
 * Annotations rebuilt from a sent message for Edit: the block's records, and which of the
 * message's last attachments were its images. `attachments` keeps the person's own files.
 */
export function returnedAnnotations<File extends { sha256: string; name: string }>(
  parsed: ParsedBrowserAnnotations,
  attachments: readonly File[],
): { annotations: DraftAnnotations; attachments: File[] } {
  const count = parsed.images.length;
  const tail = count && attachments.length >= count ? attachments.slice(-count) : [];
  const own = tail.length ? attachments.slice(0, -count) : [...attachments];
  const crops = new Map<number, { sha256: string; name: string }>();
  const pages: { url: string; sha256: string; name: string }[] = [];
  parsed.images.forEach((image, index) => {
    const file = tail[index];
    if (!file) return;
    if (image.kind === "crop") crops.set(image.number, { sha256: file.sha256, name: file.name });
    else pages.push({ url: image.url, sha256: file.sha256, name: file.name });
  });
  const items = parsed.items.map((item) => {
    const crop = crops.get(item.number);
    return { annotation: rebuilt(item), ...(crop ? { crop } : {}) };
  });
  return { annotations: { items, pages }, attachments: own };
}

function rebuilt(item: ParsedBrowserAnnotation): BrowserAnnotation {
  const box = item.box ?? { x: 0, y: 0, width: 0, height: 0 };
  const none = { x: 0, y: 0, width: 0, height: 0 };
  const region =
    item.kind === "region"
      ? {
          box,
          elements: (item.elements ?? []).map(({ tag, text, selector }) => ({
            tag,
            text,
            selector,
            xpath: "",
            box: none,
          })),
        }
      : undefined;
  return {
    id: `returned-${item.number}`,
    kind: item.kind,
    ...(region ? { region } : {}),
    number: item.number,
    documentId: "returned",
    url: item.url,
    title: item.title,
    point: { x: 0.5, y: 0.5 },
    comment: item.comment,
    element: {
      tag: item.tag,
      selector: item.selector,
      xpath: item.xpath,
      text: item.text,
      box,
    },
    styles: item.styles,
    ...(item.textChange ? { text: item.textChange } : {}),
    viewport: item.viewport ?? { width: 0, height: 0, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
  };
}
