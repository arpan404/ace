import { ContentPart } from "@ace/protocol";
import { base64DataUrl, isBase64 } from "@ace/provider-kit/data-url";
/** Validate and budget caller input before assembling a native command. */
export function piInput(input: ContentPart[]) {
  const parts = ContentPart.array().max(256).parse(input);
  const text: string[] = [],
    images: { type: "image"; data: string; mimeType: string }[] = [];
  let bytes = 0;
  for (const part of parts) {
    if (part.type === "mention") throw new Error("Unresolved Pi mention");
    const value = part.type === "text" ? part.text : part.type === "file" ? part.path : part.url;
    if (value.length > 1024 * 1024) throw new Error("Pi input exceeds frame budget");
    bytes += Buffer.byteLength(value) + 256;
    if (bytes > 1024 * 1024) throw new Error("Pi input exceeds frame budget");
    if (part.type === "text") text.push(part.text);
    else if (part.type === "file") text.push(`File: ${part.path}`);
    else {
      const image = base64DataUrl(part.url);
      if (!image || !isBase64(image.data) || image.mimeType !== part.mimeType)
        throw new Error("Pi images require a matching base64 data URL");
      images.push({ type: "image", data: image.data, mimeType: part.mimeType });
    }
  }
  const message = text.join("\n");
  if (/^\/ace-(?:rollback|context)(?:\s|$)/.test(message.trimStart()))
    throw new Error("Reserved Pi control command");
  return { message, ...(images.length ? { images } : {}) };
}
