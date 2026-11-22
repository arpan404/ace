import type { SpadeDocumentRef, SpadeImageRef, SpadeVoiceRef } from "./media.ts";
import type { SpadeKnownEvent } from "./wire.ts";

/*
 * Whether a message Spade stored is one the person sent from here and still shows as sending:
 * the fold drops the pending copy once its stored copy arrives.
 */

const sameImages = (a: readonly SpadeImageRef[], b: readonly SpadeImageRef[]) =>
  a.length === b.length && a.every((image, index) => image.sha256 === b[index]?.sha256);

/** The same file: by hash when both know it, else by name and size. */
const sameDocument = (a: SpadeDocumentRef, b: SpadeDocumentRef) =>
  a.sha256 && b.sha256 ? a.sha256 === b.sha256 : a.name === b.name && a.bytes === b.bytes;

const sameDocuments = (a: readonly SpadeDocumentRef[], b: readonly SpadeDocumentRef[]) =>
  a.length === b.length && a.every((document, index) => sameDocumentAt(document, b[index]));
const sameDocumentAt = (a: SpadeDocumentRef, b: SpadeDocumentRef | undefined) =>
  b !== undefined && sameDocument(a, b);

/** Both carry no recording, or the same one (by hash when both know it, else by size). */
const sameVoice = (a: SpadeVoiceRef | undefined, b: SpadeVoiceRef | undefined) =>
  a === undefined || b === undefined
    ? a === b
    : a.sha256 && b.sha256
      ? a.sha256 === b.sha256
      : a.bytes === b.bytes;

/**
 * Whether Spade's stored `event` is the person's pending `message`: the same words, images,
 * documents and recording. A stored message that only shares the words is another one.
 */
export const spadeSameMessage = (
  message: {
    text: string;
    images: readonly SpadeImageRef[];
    documents?: readonly SpadeDocumentRef[];
    voice?: SpadeVoiceRef;
  },
  event: Extract<SpadeKnownEvent, { type: "user_message" }>,
) =>
  message.text === event.text &&
  sameImages(message.images, event.images) &&
  sameDocuments(message.documents ?? [], event.documents) &&
  sameVoice(message.voice, event.voice);
