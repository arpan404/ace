import {
  SpadeRequestError,
  type SpadeDocumentRef,
  type SpadeImageRef,
  type SpadeVoiceRef,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { chunkBytes, Picked, type ChunkReader } from "./thread-attachments.ts";

/*
 * What a message from the iPhone sends Spade besides its words (ADR 0134, spade/docs/media.md):
 * pictures as they are, any other file as a document Spade reads, and one voice recording. Swift
 * stages each on the phone (`AttachmentStaging`) and names it here by its local id, size and
 * hash; Spade's limits are checked first, in web's words (`spade-attachments.ts` there), so a
 * message Spade would refuse never starts, and only then is each file read, a chunk at a time.
 */

/** What Swift names: the picked files, and a recording. */
export const SpadeAttachmentsWire = {
  files: z.array(Picked).max(64).optional(),
  voice: Picked.optional(),
};

export const maxSpadeImages = 8;
export const maxSpadeDocuments = 8;
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Providers count 5 MB on the base64, which is 3.75 MB of image. */
const maxImageBytes = 3_750_000;
const maxDocumentBytes = 32_000_000;
const maxVoiceBytes = 25_000_000;

export interface SpadePicks {
  images: Picked[];
  documents: Picked[];
  voice: Picked | undefined;
}

/**
 * The picks as Spade takes them, PNG, JPEG, GIF and WebP as images and the rest as documents,
 * or the sentence that says why Spade wouldn't take them.
 */
export function spadePicks(
  files: readonly Picked[],
  voice: Picked | undefined,
): SpadePicks | { problem: string } {
  const images = files.filter((file) => imageTypes.has(file.mimeType));
  const documents = files.filter((file) => !imageTypes.has(file.mimeType));
  if (images.length > maxSpadeImages)
    return { problem: `Spade takes at most ${maxSpadeImages} images in a message.` };
  if (documents.length > maxSpadeDocuments)
    return { problem: `Spade takes at most ${maxSpadeDocuments} documents in a message.` };
  const bigImage = images.find((file) => file.bytes > maxImageBytes);
  if (bigImage)
    return { problem: `${bigImage.name} is larger than 3.75 MB, the most Spade takes.` };
  const bigDocument = documents.find((file) => file.bytes > maxDocumentBytes);
  if (bigDocument)
    return { problem: `${bigDocument.name} is larger than 32 MB, the most Spade takes.` };
  if (voice && voice.bytes > maxVoiceBytes)
    return { problem: "The recording is longer than Spade takes (25 MB)." };
  return { images, documents, voice };
}

/**
 * One staged file's bytes as base64, pulled from Swift a chunk at a time; throws in the person's
 * words when Swift no longer holds it or it changed since it was named. Each chunk is a whole
 * number of three-byte groups, so the pieces join into one base64 string as they come.
 */
export async function readStaged(
  read: ChunkReader,
  file: Picked,
  signal: AbortSignal,
): Promise<string> {
  const gone = () => new Error(`${file.name} is no longer on this phone. Attach it again.`);
  const pieces: string[] = [];
  let length = 0;
  for (let offset = 0; offset < file.bytes; offset += chunkBytes) {
    signal.throwIfAborted();
    const limit = Math.min(chunkBytes, file.bytes - offset);
    let piece: string;
    try {
      piece = await read(file.localId, offset, limit);
    } catch {
      throw gone();
    }
    const got = decodedLength(piece);
    if (got !== limit) throw gone();
    pieces.push(piece);
    length += got;
  }
  if (length !== file.bytes) throw gone();
  return pieces.join("");
}

const decodedLength = (data: string) =>
  (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

/** The message as Spade's `POST …/messages` takes it, and the refs its bubble shows at once. */
export interface SpadeOutgoing {
  body: Record<string, unknown>;
  images: SpadeImageRef[];
  documents: SpadeDocumentRef[];
  voice: SpadeVoiceRef | undefined;
}

/**
 * Every pick read, and the message built: images as `{data}`, documents as `{name, data}`, the
 * recording with its transcript (`hear` asks Spade when the person wrote no words).
 */
export async function spadeOutgoing(
  text: string,
  picks: SpadePicks,
  read: ChunkReader,
  hear: (data: string, mediaType: string) => Promise<string>,
  signal: AbortSignal,
): Promise<SpadeOutgoing> {
  const images: string[] = [];
  for (const image of picks.images) images.push(await readStaged(read, image, signal));
  const documents: string[] = [];
  for (const document of picks.documents) documents.push(await readStaged(read, document, signal));
  const recording = picks.voice && (await readStaged(read, picks.voice, signal));
  const voice = picks.voice;
  const words = voice && recording && !text ? await hear(recording, voice.mimeType) : text;
  return {
    body: {
      text: words,
      ...(images.length ? { images: images.map((data) => ({ data })) } : {}),
      ...(documents.length
        ? { files: picks.documents.map((file, at) => ({ name: file.name, data: documents[at] })) }
        : {}),
      ...(voice && recording
        ? { voice: { data: recording, media_type: voice.mimeType, transcript: words } }
        : {}),
    },
    images: picks.images.map((file) => ({
      sha256: file.sha256,
      mediaType: file.mimeType,
      bytes: file.bytes,
    })),
    documents: picks.documents.map((file) => ({
      sha256: file.sha256,
      name: file.name,
      mediaType: file.mimeType || "application/octet-stream",
      bytes: file.bytes,
      pages: undefined,
      sheets: undefined,
      chars: 0,
      cut: false,
    })),
    voice: voice && { sha256: voice.sha256, mediaType: voice.mimeType, bytes: voice.bytes },
  };
}

/**
 * Uploads with files may be hundreds of megabytes: five minutes, and a second more for every
 * megabyte, as web allows; a message of words keeps the transport's default.
 */
export const spadeUploadMs = (length: number) =>
  length > 512 * 1024 ? 5 * 60_000 + Math.ceil(length / 1_000_000) * 1_000 : undefined;

/** Posts to Spade and resolves with its text answer; throws `SpadeRequestError` on a refusal. */
type Post = (method: "POST", route: string, body: unknown, timeoutMs?: number) => Promise<string>;

/** A message of words alone, ready at once so it shows at once; none is no message. */
export const spadeWords = (text: string): SpadeOutgoing | { problem: string } =>
  text.trim()
    ? { body: { text: text.trim() }, images: [], documents: [], voice: undefined }
    : { problem: "Write a message or attach something to send." };

/**
 * The message as Spade takes it, or why it can't go. With files: Spade's limits first, then every file read from the phone, then, for a
 * recording with no words, its transcript from Spade's transcription model. Nothing reaches the
 * conversation until all of it is ready.
 */
export async function prepareSpadeSend(
  message: { text: string; files?: readonly Picked[] | undefined; voice?: Picked | undefined },
  read: ChunkReader,
  post: Post,
  signal: AbortSignal,
): Promise<SpadeOutgoing | { problem: string }> {
  const text = message.text.trim();
  const files = message.files ?? [];
  if (!files.length && !message.voice) return spadeWords(text);
  const picks = spadePicks(files, message.voice);
  if ("problem" in picks) return picks;
  try {
    return await spadeOutgoing(
      text,
      picks,
      read,
      (data, type) => transcribe(post, data, type),
      signal,
    );
  } catch (error) {
    return { problem: (error instanceof Error && error.message) || "Try again." };
  }
}

/** What Spade's transcription model heard in a recording; throws in the person's words. */
async function transcribe(post: Post, data: string, mediaType: string): Promise<string> {
  let answer: string;
  try {
    answer = await post(
      "POST",
      "/v1/transcriptions",
      { data, media_type: mediaType },
      spadeUploadMs(data.length),
    );
  } catch (error) {
    if (error instanceof SpadeRequestError && error.status === 409)
      throw new Error("Choose a transcription model in Settings › Spade to send voice messages.", {
        cause: error,
      });
    throw error;
  }
  const heard = z.object({ text: z.string() }).safeParse(JSON.parse(answer));
  const words = heard.success ? heard.data.text.trim() : "";
  if (!words) throw new Error("Spade heard no words in the recording. Try again.");
  return words;
}
