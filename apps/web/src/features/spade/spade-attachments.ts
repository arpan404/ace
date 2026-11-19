import type { SpadeDocumentRef, SpadeImageRef, SpadeVoiceRef } from "@ace/ui-core/spade-chat";
import { keepSentPicture, keepSentRecording } from "./spade-images.ts";

/*
 * What a message sends Spade besides its words (ADR 0134, spade/docs/media.md): images as they
 * are, any other file as a document Spade reads, and a voice recording. Spade's own limits are
 * checked here so the person hears why at once; what a file holds, Spade decides.
 */

/** Spade's limits: images and documents are counted apart. */
export const maxSpadeImages = 8;
export const maxSpadeDocuments = 8;
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Providers count 5 MB on the base64, which is 3.75 MB of image. */
const maxImageBytes = 3_750_000;
const maxDocumentBytes = 32_000_000;
const maxVoiceBytes = 25_000_000;

export interface PreparedImage {
  /** Base64 of the file as it is, as Spade takes it. */
  data: string;
  ref: SpadeImageRef;
}

export interface PreparedDocument {
  name: string;
  data: string;
  ref: SpadeDocumentRef;
}

export interface PreparedVoice {
  data: string;
  mediaType: string;
  ref: SpadeVoiceRef;
}

/** What Spade is sent: words, images, documents and a recording, any of which may be absent. */
export interface SpadeMessage {
  text: string;
  images: PreparedImage[];
  documents?: PreparedDocument[];
  voice?: PreparedVoice | undefined;
}

export class SpadeAttachmentError extends Error {}

export function base64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function read(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, data: base64(bytes), hash: await sha256(bytes) };
}

/** Whether Spade takes the file as an image; anything else goes as a document. */
const isImage = (file: File) => imageTypes.has(file.type);

/**
 * The message's files as Spade takes them: PNG, JPEG, GIF and WebP as images (at most eight,
 * 3.75 MB each), everything else as documents (at most eight, 32 MB each). Throws
 * `SpadeAttachmentError` with words for the person otherwise.
 */
export async function prepareSpadeFiles(
  files: readonly File[],
): Promise<{ images: PreparedImage[]; documents: PreparedDocument[] }> {
  const images = files.filter(isImage);
  const documents = files.filter((file) => !isImage(file));
  if (images.length > maxSpadeImages)
    throw new SpadeAttachmentError(`Spade takes at most ${maxSpadeImages} images in a message.`);
  if (documents.length > maxSpadeDocuments)
    throw new SpadeAttachmentError(
      `Spade takes at most ${maxSpadeDocuments} documents in a message.`,
    );
  for (const file of images)
    if (file.size > maxImageBytes)
      throw new SpadeAttachmentError(`${file.name} is larger than 3.75 MB, the most Spade takes.`);
  for (const file of documents)
    if (file.size > maxDocumentBytes)
      throw new SpadeAttachmentError(`${file.name} is larger than 32 MB, the most Spade takes.`);
  return {
    images: await Promise.all(
      images.map(async (file) => {
        const { bytes, data, hash } = await read(file);
        keepSentPicture(hash, file);
        return { data, ref: { sha256: hash, mediaType: file.type, bytes: bytes.length } };
      }),
    ),
    documents: await Promise.all(
      documents.map(async (file) => {
        const { bytes, data, hash } = await read(file);
        const ref: SpadeDocumentRef = {
          sha256: hash,
          name: file.name,
          mediaType: file.type || "application/octet-stream",
          bytes: bytes.length,
          pages: undefined,
          sheets: undefined,
          chars: 0,
          cut: false,
        };
        return { name: file.name, data, ref };
      }),
    ),
  };
}

/** A recording as Spade takes it: at most 25 MB. */
export async function prepareSpadeVoice(recording: Blob): Promise<PreparedVoice> {
  if (recording.size > maxVoiceBytes)
    throw new SpadeAttachmentError("The recording is longer than Spade takes (25 MB).");
  const { bytes, data, hash } = await read(recording);
  const mediaType = recording.type.split(";")[0] || "audio/webm";
  keepSentRecording(hash, recording);
  return { data, mediaType, ref: { sha256: hash, mediaType, bytes: bytes.length } };
}
