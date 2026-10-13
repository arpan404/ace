import { z } from "zod";
import { Attachment } from "./context.ts";

export const HtmlDocument = z.string().min(1).max(262144);
export const HtmlHeight = z.number().int().min(80).max(2000);
/**
 * How a published page runs. `interactive` runs its scripts in the visualization sandbox;
 * `static` strips them and renders a plain themed page. Absent, it is inferred from the page:
 * `static` when it has no script, otherwise `interactive`.
 */
export const HtmlMode = z.enum(["interactive", "static"]);
export type HtmlMode = z.infer<typeof HtmlMode>;
export const HtmlPreviewInput = z.strictObject({ html: z.string().max(1024 * 1024) });
export const HtmlRenderInput = z.strictObject({
  title: z.string().min(1).max(160).regex(/\S/),
  html: HtmlDocument,
  height: HtmlHeight.optional(),
  mode: HtmlMode.optional(),
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
  /** Resolved and stored at publication; when absent, clients infer it by the same rule. */
  mode: HtmlMode.optional(),
});
export type HtmlVisualization = z.infer<typeof HtmlVisualization>;
export const HtmlHeightMessage = z.strictObject({
  type: z.literal("ace.html.height"),
  height: z.number().finite().min(1).max(10000),
});
