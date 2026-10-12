import { z } from "zod";
import { Attachment } from "./context.ts";

export const HtmlDocument = z.string().min(1).max(262144);
export const HtmlHeight = z.number().int().min(80).max(2000);
export const HtmlPreviewInput = z.strictObject({ html: HtmlDocument });
export const HtmlRenderInput = z.strictObject({
  title: z.string().trim().min(1).max(160),
  html: HtmlDocument,
  height: HtmlHeight.optional(),
});
export type HtmlRenderInput = z.infer<typeof HtmlRenderInput>;
export const HtmlDiagnostics = z.object({
  valid: z.boolean(),
  bytes: z.number().int().nonnegative(),
  maxBytes: z.number().int().positive(),
  diagnostics: z.array(z.object({ code: z.string(), message: z.string() })).max(32),
});
export type HtmlDiagnostics = z.infer<typeof HtmlDiagnostics>;
export const HtmlVisualization = z.object({
  title: z.string().min(1).max(160),
  document: Attachment,
  height: HtmlHeight.optional(),
});
export const HtmlHeightMessage = z.strictObject({
  type: z.literal("ace.html.height"),
  height: z.number().finite().min(1).max(10000),
});
