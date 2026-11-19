import { z } from "zod";
import { Attachment } from "./context.ts";

/** A page with its base64 images inline: as large as the largest base64 image an agent may post. */
export const maxHtmlDocumentBytes = 16 * 1024 * 1024;
export const HtmlDocument = z.string().min(1).max(maxHtmlDocumentBytes);
export const HtmlHeight = z.number().int().min(80).max(2000);
/**
 * How a published page runs. `interactive` runs its scripts in the visualization sandbox;
 * `static` strips them and renders a plain themed page. Absent, it is inferred from the page:
 * `static` when it has no script, otherwise `interactive`.
 */
export const HtmlMode = z.enum(["interactive", "static"]);
export type HtmlMode = z.infer<typeof HtmlMode>;
/** A version of the style kit every page is rendered with (`@ace/html` `styleKitVersion`). */
export const HtmlStyleKit = z.number().int().min(1).max(1000);
export type HtmlStyleKit = z.infer<typeof HtmlStyleKit>;
export const HtmlRenderInput = z.strictObject({
  title: z.string().min(1).max(160).regex(/\S/),
  html: HtmlDocument,
  height: HtmlHeight.optional(),
  mode: HtmlMode.optional(),
});
export type HtmlRenderInput = z.infer<typeof HtmlRenderInput>;
/** The app theme a preview is drawn in. */
export const HtmlColorScheme = z.enum(["dark", "light"]);
export type HtmlColorScheme = z.infer<typeof HtmlColorScheme>;
/**
 * The widths a page is shown at: the chat on a phone, the desktop message column, and full screen
 * in the side panel.
 */
export const HtmlPreviewWidth = z.literal([360, 760, 1200]);
export type HtmlPreviewWidth = z.infer<typeof HtmlPreviewWidth>;
/** A page to lay out and look at before publishing it; nothing is stored or shown. */
export const HtmlPreviewInput = z.strictObject({
  html: HtmlDocument,
  mode: HtmlMode.optional(),
  scheme: HtmlColorScheme.optional(),
  widths: z.array(HtmlPreviewWidth).min(1).max(3).optional(),
});
export type HtmlPreviewInput = z.infer<typeof HtmlPreviewInput>;
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
  /**
   * The style kit the page was written against, stored at publication. Absent on pages from
   * before the kit was versioned: they render with the first kit, whose classes are unprefixed.
   */
  kit: HtmlStyleKit.optional(),
});
export type HtmlVisualization = z.infer<typeof HtmlVisualization>;
export const HtmlHeightMessage = z.strictObject({
  type: z.literal("ace.html.height"),
  height: z.number().finite().min(1).max(10000),
});
