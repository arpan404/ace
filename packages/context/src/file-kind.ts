import { extname } from "node:path";

const types: Record<string, string> = {
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
};
export function binaryMime(name: string, declared?: string): string {
  return (
    types[extname(name).slice(1).toLowerCase()] ??
    (declared && /^[\w.+-]+\/[\w.+-]+$/.test(declared) ? declared : "application/octet-stream")
  );
}
export function textEncoding(header: Uint8Array): "utf-8" | "utf-16le" | "utf-16be" {
  if (header[0] === 255 && header[1] === 254) return "utf-16le";
  if (header[0] === 254 && header[1] === 255) return "utf-16be";
  // BOM-less UTF-16 with an ASCII prefix, common for Windows source/log files.
  if (header.length >= 4 && header[1] === 0 && header[3] === 0 && header[0] && header[2])
    return "utf-16le";
  if (header.length >= 4 && header[0] === 0 && header[2] === 0 && header[1] && header[3])
    return "utf-16be";
  return "utf-8";
}
export function printableText(text: string): boolean {
  // Control bytes distinguish decodable binary headers from source text.
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000e-\u001a\u001c-\u001f\u007f]/.test(text);
}
export function languageHint(name: string): string {
  const extension = extname(name).slice(1).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(extension) ? extension : "text";
}
