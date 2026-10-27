/*
 * What the thread's provider and model read natively: the provider's `imageInput` capability and
 * the model's input modalities from the catalog. No file is refused for its type: the daemon
 * delivers every attachment natively, as inline text or as a readable file path (ADR 0034,
 * "Every file type"), so only the shared size limits (`attachment-limits.ts`) refuse an upload.
 * Images matter only where a thread moves to a model that can't see the ones it carries.
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
