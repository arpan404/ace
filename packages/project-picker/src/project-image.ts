/*
 * A project's own image travels as a small raster data URL. The schema checks its shape; this
 * checks that the bytes are the image type the URL names, so a renamed file or a script never
 * lands as a project badge. Remote https icons are not read here.
 */

/** Image types a project badge accepts, by MIME type. */
export const projectImageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ProjectImageType = (typeof projectImageTypes)[number];

/** The largest file a person can pick; it is cropped and scaled down before it is saved. */
export const projectImageMaxBytes = 5 * 1024 * 1024;

/** The saved image's side in pixels. */
export const projectImageSize = 128;

const signatures: Record<string, (bytes: Uint8Array) => boolean> = {
  "image/png": (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (b) => starts(b, [0xff, 0xd8, 0xff]),
  "image/gif": (b) => text(b, 0, "GIF87a") || text(b, 0, "GIF89a"),
  "image/webp": (b) => text(b, 0, "RIFF") && text(b, 8, "WEBP"),
  "image/x-icon": (b) => starts(b, [0x00, 0x00, 0x01, 0x00]),
};

function starts(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function text(bytes: Uint8Array, offset: number, value: string): boolean {
  for (let index = 0; index < value.length; index++)
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  return true;
}

/** The first bytes of base64 text, enough to read an image signature. */
function head(base64: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const chunk = base64.slice(0, 24).replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of chunk) {
    const value = alphabet.indexOf(char);
    if (value < 0) return new Uint8Array();
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** The image type a file's first bytes show, if it is one a project badge accepts. */
export function sniffProjectImage(bytes: Uint8Array): ProjectImageType | undefined {
  return projectImageTypes.find((type) => signatures[type]?.(bytes));
}

/**
 * Whether a project icon is acceptable as saved: remote URLs pass; a data URL must hold the
 * image type it names. False for a data URL whose bytes are something else.
 */
export function projectIconMatches(icon: string): boolean {
  const match = /^data:(image\/[a-z-]+);base64,(.*)$/s.exec(icon);
  if (!match) return !icon.startsWith("data:");
  const check = signatures[match[1] ?? ""];
  return check !== undefined && check(head(match[2] ?? ""));
}
