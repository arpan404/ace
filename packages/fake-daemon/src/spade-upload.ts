import { base64Bytes, sha256Hex } from "./sha256.ts";

type Json = Record<string, unknown>;

/** What Spade names an upload by: the SHA-256 of its bytes, and their count. */
function uploadIdentity(data: unknown) {
  let bytes: Uint8Array;
  try {
    bytes = base64Bytes(String(data));
  } catch {
    bytes = new TextEncoder().encode(String(data));
  }
  return { sha256: sha256Hex(bytes), bytes: bytes.length };
}

/** A sent message's images, documents and recording, stored as Spade stores them (ADR 0134). */
export function mediaOf(body: Json): Json {
  const images = Array.isArray(body.images) ? (body.images as Json[]) : [];
  const files = Array.isArray(body.files) ? (body.files as Json[]) : [];
  const voice = body.voice as Json | undefined;
  return {
    ...(images.length
      ? {
          images: images.map((image) => {
            const { sha256, bytes } = uploadIdentity(image.data);
            return { sha256, media_type: "image/png", bytes };
          }),
        }
      : {}),
    ...(files.length
      ? {
          documents: files.map((file) => {
            const { sha256, bytes } = uploadIdentity(file.data);
            const name = String(file.name);
            const pdf = name.endsWith(".pdf");
            const media_type = pdf ? "application/pdf" : "application/octet-stream";
            return { sha256, name, media_type, bytes, chars: 0, cut: false, view: "" };
          }),
        }
      : {}),
    ...(voice
      ? {
          voice: {
            ...uploadIdentity(voice.data),
            media_type: String(voice.media_type),
          },
        }
      : {}),
  };
}
