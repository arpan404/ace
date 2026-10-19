import { attachmentBytes, type ClientCore } from "@ace/client";
import { designTokens } from "@ace/design-tokens";
import { resolveHtmlMode, visualizationWindow, type HtmlTheme } from "@ace/html";
import { ItemId, ThreadId } from "@ace/protocol";
import { z } from "zod";

export const NativeMediaRequest = z.object({
  type: z.literal("native.media"),
  threadId: ThreadId,
  itemId: ItemId,
  scheme: z.enum(["light", "dark"]),
});

/** Resolve only an attachment actually published into this thread; never accept a caller URL. */
export async function readNativeMedia(
  owner: ClientCore,
  request: z.infer<typeof NativeMediaRequest>,
  signal: AbortSignal,
) {
  const item = owner.cachedThread(request.threadId)?.item(request.itemId);
  if (!item || (item.type !== "html" && item.type !== "image"))
    throw new Error("Media unavailable");
  const attachment = item.type === "html" ? item.visualization.document : item.image.attachment;
  const variant = item.type === "image" && attachment.thumbnailAvailable ? "thumbnail" : "original";
  const result = await attachmentBytes(
    owner,
    { threadId: request.threadId, sha256: attachment.sha256, variant, maxBytes: 16 * 1024 * 1024 },
    { signal },
  );
  if (item.type === "html") {
    const html = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
    const colours = designTokens.schemes[request.scheme].colours;
    const theme: HtmlTheme = {
      colorScheme: request.scheme,
      background: colours.background,
      foreground: colours.foreground,
      "muted-foreground": colours.mutedForeground,
      card: colours.card,
      border: colours.separator,
      accent: colours.accent,
    };
    return {
      kind: "html",
      // WKWebView uses a 980px desktop layout viewport without a viewport
      // meta, shrinking canvas content to ~one-third size. The shared
      // visualizationWindow wrapper is trusted web output; add the mobile
      // viewport here at the native boundary without touching CSP,
      // sandbox, or nested authored HTML.
      document: visualizationWindow(html, theme, resolveHtmlMode(html, item.visualization.mode)).replace(
        "<head>",
        '<head><meta name="viewport" content="width=device-width, initial-scale=1">',
      ),
    };
  }
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(result.mimeType))
    throw new Error("Unsupported image");
  const parts: string[] = [];
  for (let offset = 0; offset < result.bytes.length; offset += 8192)
    parts.push(String.fromCharCode(...result.bytes.subarray(offset, offset + 8192)));
  return { kind: "image", data: btoa(parts.join("")) };
}
