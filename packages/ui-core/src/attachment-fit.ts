/*
 * Whether the agent can read a file attached to the next message, decided before it is sent
 * (QA-07) from what the thread's provider and model say they take: the provider's `imageInput`
 * capability and the model's input modalities from the catalog. The daemon checks again when
 * it delivers the message; this only keeps the person from sending what it would drop.
 */

/** What the thread runs on reads, as far as ace knows it. */
export interface AttachmentReader {
  /** "Codex". */
  provider: string;
  /** The provider takes images (`Capabilities.imageInput`); undefined while unknown. */
  imageInput: boolean | undefined;
  /** The model, for words: "GPT-5 Codex". */
  model?: string | undefined;
  /** The model's input modalities (`CatalogModel.inputModalities`); empty or absent if unlisted. */
  modalities?: readonly string[] | undefined;
}

/** Why images can't go to the agent, when the provider or the model says it doesn't read them. */
export function imagesUnreadable(reader: AttachmentReader | undefined): string | undefined {
  if (!reader) return undefined;
  if (reader.imageInput === false) return `${reader.provider} doesn't read images.`;
  if (reader.modalities?.length && !reader.modalities.includes("image"))
    return `${reader.model ?? "This model"} doesn't read images. Pick a model that does.`;
  return undefined;
}

/**
 * Why the agent can't read `file`, in words with the next step, or undefined when it can (or
 * ace can't tell yet: an unknown type, or capabilities not read). Images need the provider's
 * image input and, where the catalog lists modalities, the model's. No capability covers any
 * other upload, so a document or text file is refused with the way that works: an @ mention.
 */
export function attachmentProblem(
  file: { name: string; mimeType?: string | undefined },
  reader: AttachmentReader | undefined,
): string | undefined {
  const type = file.mimeType?.toLowerCase();
  if (!reader || !type || type === "application/octet-stream") return undefined;
  if (type.startsWith("image/")) return imagesUnreadable(reader);
  if (reader.imageInput === undefined) return undefined;
  return `${reader.provider} can't read attached files like ${file.name}. Mention it with @ instead, or paste what matters.`;
}
