import { ContentPart } from "@ace/protocol";
/** Validate and budget caller input before assembling a native command. */
export function piInput(input: ContentPart[]) {
  const parts = ContentPart.array().max(256).parse(input);
  const text: string[] = [],
    images: { type: "image"; data: string; mimeType: string }[] = [];
  let bytes = 0;
  for (const part of parts) {
    const value = part.type === "text" ? part.text : part.type === "file" ? part.path : part.url;
    if (value.length > 1024 * 1024) throw new Error("Pi input exceeds frame budget");
    bytes += Buffer.byteLength(value) + 256;
    if (bytes > 1024 * 1024) throw new Error("Pi input exceeds frame budget");
    if (part.type === "text") text.push(part.text);
    else if (part.type === "file") text.push(`File: ${part.path}`);
    else {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(part.url);
      if (!match?.[2] || match[1] !== part.mimeType)
        throw new Error("Pi images require a matching base64 data URL");
      images.push({ type: "image", data: match[2], mimeType: part.mimeType });
    }
  }
  const message = text.join("\n");
  if (/^\/ace-(?:rollback|context)(?:\s|$)/.test(message.trimStart()))
    throw new Error("Reserved Pi control command");
  return { message, ...(images.length ? { images } : {}) };
}
