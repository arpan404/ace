import { z } from "zod";
import { formatBytes } from "../byte-size.ts";

/*
 * What a message carries besides words (ADR 0134, spade/docs/media.md): images, documents and a
 * voice recording, each stored by Spade under its hash. Read leniently: an entry this client
 * can't read is left out, and the message still shows.
 */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative();

/** An image the person attached or a bot showed, stored by Spade under its hash. */
export interface SpadeImageRef {
  sha256: string;
  mediaType: string;
  bytes: number;
}

/** A document the person attached or a bot shared, with what Spade read of it. */
export interface SpadeDocumentRef {
  sha256: string;
  name: string;
  mediaType: string;
  bytes: number;
  /** A PDF's pages; undefined for anything else. */
  pages: number | undefined;
  /** A spreadsheet's sheets; undefined for anything else. */
  sheets: number | undefined;
  /** Characters of text Spade kept. */
  chars: number;
  /** The text was cut at Spade's cap. */
  cut: boolean;
}

/** A voice message's recording; its transcript is the message's text. */
export interface SpadeVoiceRef {
  sha256: string;
  mediaType: string;
  bytes: number;
}

const imageShape = z.object({
  sha256,
  media_type: z.string().catch("image/png").default("image/png"),
  bytes: count.catch(0).default(0),
});

const documentShape = z.object({
  sha256,
  name: z.string().min(1),
  media_type: z.string().catch("application/octet-stream").default("application/octet-stream"),
  bytes: count.catch(0).default(0),
  pages: count.nullish().catch(undefined),
  sheets: count.nullish().catch(undefined),
  chars: count.catch(0).default(0),
  cut: z.boolean().catch(false).default(false),
});

const voiceShape = z.object({
  sha256,
  media_type: z.string().catch("audio/webm").default("audio/webm"),
  bytes: count.catch(0).default(0),
});

function each<T>(read: (item: unknown) => T | undefined) {
  return z
    .unknown()
    .optional()
    .transform((list): T[] =>
      Array.isArray(list)
        ? list.flatMap((item) => {
            const value = read(item);
            return value === undefined ? [] : [value];
          })
        : [],
    );
}

function imageOf(raw: unknown): SpadeImageRef | undefined {
  const parsed = imageShape.safeParse(raw);
  if (!parsed.success) return undefined;
  return {
    sha256: parsed.data.sha256,
    mediaType: parsed.data.media_type,
    bytes: parsed.data.bytes,
  };
}

function documentOf(raw: unknown): SpadeDocumentRef | undefined {
  const parsed = documentShape.safeParse(raw);
  if (!parsed.success) return undefined;
  const doc = parsed.data;
  return {
    sha256: doc.sha256,
    name: doc.name,
    mediaType: doc.media_type,
    bytes: doc.bytes,
    pages: doc.pages ?? undefined,
    sheets: doc.sheets ?? undefined,
    chars: doc.chars,
    cut: doc.cut,
  };
}

/** `images` / `shared_images`: the ones this client can read. */
export const spadeImageList = each(imageOf);
/** `documents` / `shared_documents`: the ones this client can read. */
export const spadeDocumentList = each(documentOf);
/** `voice`: undefined when absent or unreadable. */
export const spadeVoiceField = z
  .unknown()
  .optional()
  .transform((raw): SpadeVoiceRef | undefined => {
    const parsed = voiceShape.safeParse(raw);
    if (!parsed.success) return undefined;
    return {
      sha256: parsed.data.sha256,
      mediaType: parsed.data.media_type,
      bytes: parsed.data.bytes,
    };
  });

const plural = (n: number, one: string) =>
  `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

/** A document's chip line after its name: "12 pages · 482 KB", "3 sheets · 1.2 MB", "4 KB". */
export function spadeDocumentFacts(doc: Pick<SpadeDocumentRef, "pages" | "sheets" | "bytes">) {
  const parts: string[] = [];
  if (doc.pages !== undefined) parts.push(plural(doc.pages, "page"));
  else if (doc.sheets !== undefined) parts.push(plural(doc.sheets, "sheet"));
  if (doc.bytes > 0) parts.push(formatBytes(doc.bytes));
  return parts.join(" · ");
}

/** Model capabilities ADR 0134 adds, as Spade names them. */
export const spadeMediaCapabilities = [
  "pdf-input",
  "image-generation",
  "image-output",
  "transcription",
] as const;
export type SpadeMediaCapability = (typeof spadeMediaCapabilities)[number];

/** Whether a model's facts include `capability`. */
export function spadeModelCan(
  model: { capabilities: readonly string[] },
  capability: SpadeMediaCapability,
): boolean {
  return model.capabilities.includes(capability);
}
