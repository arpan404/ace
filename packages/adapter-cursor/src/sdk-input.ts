import type { SendOptions } from "./contracts.ts";

/** Pure mapping from admitted ace content to the local SDK's text/image input. */
export function sdkInput(input: SendOptions["input"]) {
  const texts: string[] = [],
    images: { url: string }[] = [];
  for (const part of input) {
    if (part.type === "text") texts.push(part.text);
    else if (part.type === "image") images.push({ url: part.url });
    else texts.push(`Referenced workspace file: ${part.path}`);
  }
  return { text: texts.join("\n"), ...(images.length ? { images } : {}) };
}
