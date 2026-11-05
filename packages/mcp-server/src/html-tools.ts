import { z } from "zod";
import {
  HtmlPreviewInput,
  HtmlRenderInput,
  ItemId,
  type HtmlDiagnostics,
  type HtmlMode,
  type HtmlColorScheme,
  type HtmlPreviewWidth,
  type McpAttribution,
} from "@ace/protocol";
import {
  checkHtmlForPublish,
  estimateHtmlLayout,
  lintHtmlLayout,
  previewWidths,
  resolveHtmlMode,
  validateHtml,
} from "@ace/html";
import { PublicToolError } from "./public-error.ts";
import { maxHtmlInputBytes } from "./result-budgets.ts";
import type { Toolkit } from "./toolkits.ts";

export interface HtmlPublicationPort {
  publish(
    caller: McpAttribution,
    input: HtmlRenderInput,
    signal: AbortSignal,
  ): Promise<{ itemId: string }>;
}
type Diagnostic = HtmlDiagnostics["diagnostics"][number];
/** Lays a page out at the phone width before it is published. */
export interface HtmlLayoutPort {
  /** What breaks at the phone width; `undefined` when the page could not be laid out. */
  measure(
    page: { html: string; mode: HtmlMode },
    signal: AbortSignal,
  ): Promise<Diagnostic[] | undefined>;
}
/** A preview: one image per width, in the order asked, and the measured layout facts. */
export interface HtmlPreviewResult {
  /** One terse line per width. */
  report: string;
  /** What html_render refuses, measured at the phone width; absent when 360 was not shown. */
  problems?: Diagnostic[];
  images: { width: number; mimeType: "image/png" | "image/jpeg"; data: Buffer }[];
}
export interface HtmlPreviewPort {
  preview(
    page: {
      html: string;
      mode: HtmlMode;
      scheme: HtmlColorScheme;
      widths: readonly HtmlPreviewWidth[];
    },
    signal: AbortSignal,
  ): Promise<HtmlPreviewResult>;
}
const { title, html, height, mode } = HtmlRenderInput.shape;
const pageHtml = html.describe(
  "A self-contained HTML document: inline CSS, JS, SVG and data: images; no network.",
);
const pageMode = mode.describe(
  "interactive runs scripts in a sandbox; static strips them. Default: inferred.",
);
const RenderInput = HtmlRenderInput.extend({
  title: title.describe("Caption above the page."),
  html: pageHtml,
  height: height.describe("CSS pixels held while loading; the frame then fits the page."),
  mode: pageMode,
});
const PreviewInput = HtmlPreviewInput.extend({
  html: pageHtml,
  mode: pageMode,
  scheme: HtmlPreviewInput.shape.scheme.describe("The app theme to draw it in. Default: dark."),
  widths: HtmlPreviewInput.shape.widths.describe(
    "Phone 360, chat column 760, full-screen side panel 1200. Default: 360 and 760.",
  ),
});
export const htmlToolCatalog = [
  {
    name: "html_render",
    title: "Show an HTML visual inline",
    description:
      "Show a chart, diagram, mockup or interactive page inline in your reply. Read guide visualize first. The page is laid out at 360 px before publishing; invalid_html lists what is unsafe, overflows the phone width or is unreadable, and nothing is published.",
    input: RenderInput,
    output: z.object({ itemId: ItemId }),
    capability: null,
    riskClass: "thread-write",
    toolset: "visualize",
    timeoutMs: 30000,
    maxInputBytes: maxHtmlInputBytes,
  },
  {
    name: "html_preview",
    title: "Preview an HTML visual",
    description:
      "See a page as html_render would show it, at 360 px and 760 px (or the widths you pick), with what html_render would refuse listed. Publishes nothing.",
    input: PreviewInput,
    capability: null,
    riskClass: "read-only",
    toolset: "visualize",
    // A first preview may start the browser; later ones take about half a second.
    timeoutMs: 45000,
    maxInputBytes: maxHtmlInputBytes,
  },
] as const;

/** Every problem at once, so one call fixes the page. */
function refuse(diagnostics: readonly Diagnostic[]): void {
  if (diagnostics.length === 0) return;
  throw new PublicToolError(
    "invalid_html",
    undefined,
    undefined,
    undefined,
    undefined,
    diagnostics.slice(0, 16).map((entry) => ({
      path: "html",
      expected: `${entry.code}: ${entry.message}`.slice(0, 240),
    })),
  );
}
/**
 * html_render. The markup is checked first (safety and what breaks the frame at any width); a
 * page that passes is laid out at the phone width, and what overflows or can't be read there is
 * refused. Without a layout engine, a guess from the markup stands in.
 */
export function htmlToolkit(port: HtmlPublicationPort, layout?: HtmlLayoutPort): Toolkit {
  return {
    register(registry) {
      registry.register({
        ...htmlToolCatalog[0],
        async run(input, { caller, signal }) {
          refuse(checkHtmlForPublish(input.html).diagnostics);
          const measured = await layout?.measure(
            { html: input.html, mode: resolveHtmlMode(input.html, input.mode) },
            signal,
          );
          refuse(measured ?? estimateHtmlLayout(input.html));
          return port.publish(caller, input, signal);
        },
      });
    },
  };
}
export function htmlPreviewToolkit(port: HtmlPreviewPort): Toolkit {
  return {
    register(registry) {
      registry.registerContent({
        ...htmlToolCatalog[1],
        async run(input, { signal }) {
          // Only safety problems stop a preview; layout problems are what it is for, so they are
          // listed beside the pictures that show them (html_render refuses them).
          refuse(validateHtml(input.html).diagnostics);
          const result = await port.preview(
            {
              html: input.html,
              mode: resolveHtmlMode(input.html, input.mode),
              scheme: input.scheme ?? "dark",
              widths: input.widths ?? previewWidths,
            },
            signal,
          );
          return {
            content: [
              { type: "text", text: previewText(result, lintHtmlLayout(input.html)) },
              ...result.images.map((image) => ({
                type: "image",
                mimeType: image.mimeType,
                data: image.data.toString("base64"),
              })),
            ],
          };
        },
      });
    },
  };
}

/** The report, then what html_render would refuse: the frame rules, then the phone check. */
function previewText(result: HtmlPreviewResult, frame: readonly Diagnostic[]): string {
  const refusals = [...frame, ...(result.problems ?? [])].map((entry) =>
    `- ${entry.code}: ${entry.message}`.slice(0, 240),
  );
  const lines = [result.report];
  if (refusals.length) lines.push("html_render would refuse this page:", ...refusals);
  else if (!result.problems)
    lines.push("Include 360 in widths to see the phone check html_render runs.");
  return lines.join("\n");
}
