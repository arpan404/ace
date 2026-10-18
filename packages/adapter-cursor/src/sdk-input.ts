import type { SendOptions } from "./contracts.ts";

/**
 * Pure mapping from admitted ace content to the local SDK's text/image input.
 * Local agents accept only inline `{ data, mimeType }` images; the SDK rejects
 * `{ url }` images with "URL images are only supported for cloud SDK agents".
 */
export function sdkInput(input: SendOptions["input"]) {
  const texts: string[] = [],
    images: { data: string; mimeType: string }[] = [];
  for (const part of input) {
    if (part.type === "mention") throw new Error("Unresolved Cursor mention");
    if (part.type === "text") texts.push(part.text);
    else if (part.type === "image") {
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(part.url);
      if (!match?.[2] || match[1] !== part.mimeType)
        throw new Error("Cursor images require a matching base64 data URL");
      images.push({ data: match[2], mimeType: part.mimeType });
    } else texts.push(`Referenced workspace file: ${part.path}`);
  }
  return { text: texts.join("\n"), ...(images.length ? { images } : {}) };
}
