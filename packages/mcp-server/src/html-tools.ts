import { z } from "zod";
import {
  HtmlPreviewInput,
  HtmlRenderInput,
  ItemId,
  type HtmlMode,
  type HtmlColorScheme,
  type McpAttribution,
} from "@ace/protocol";
import { checkHtmlForPublish, lintHtmlLayout, resolveHtmlMode, validateHtml } from "@ace/html";
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
/** A preview: one image per width, narrowest first, and the measured layout facts. */
export interface HtmlPreviewResult {
  /** One terse line per width. */
  report: string;
  images: { width: number; mimeType: "image/png" | "image/jpeg"; data: Buffer }[];
}
export interface HtmlPreviewPort {
  preview(
    page: { html: string; mode: HtmlMode; scheme: HtmlColorScheme },
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
});
export const htmlToolCatalog = [
  {
    name: "html_render",
    title: "Show an HTML visual inline",
    description:
      "Show a chart, diagram, mockup or interactive page inline in your reply. Read guide visualize first and follow it. invalid_html lists every safety or layout problem; nothing is published.",
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
      "See a page as html_render would show it, at 360 px and 760 px, with layout problems listed. Publishes nothing.",
    input: PreviewInput,
    capability: null,
    riskClass: "read-only",
    toolset: "visualize",
    // A first preview may start the browser; later ones take about half a second.
    timeoutMs: 45000,
    maxInputBytes: maxHtmlInputBytes,
  },
] as const;

type Diagnostics = ReturnType<typeof validateHtml>;
/** Every problem at once, so one call fixes the page. */
function refuseInvalid(diagnostics: Diagnostics): void {
  if (diagnostics.valid) return;
  throw new PublicToolError(
    "invalid_html",
    undefined,
    undefined,
    undefined,
    undefined,
    diagnostics.diagnostics.slice(0, 16).map((entry) => ({
      path: "html",
      expected: `${entry.code}: ${entry.message}`.slice(0, 240),
    })),
  );
}
export function htmlToolkit(port: HtmlPublicationPort): Toolkit {
  return {
    register(registry) {
      registry.register({
        ...htmlToolCatalog[0],
        async run(input, { caller, signal }) {
          // One call: a page that is unsafe or breaks in the chat column comes back with every
          // problem, and nothing is published.
          refuseInvalid(checkHtmlForPublish(input.html));
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
          refuseInvalid(validateHtml(input.html));
          const layout = lintHtmlLayout(input.html).map((entry) =>
            `- ${entry.code}: ${entry.message}`.slice(0, 240),
          );
          const result = await port.preview(
            {
              html: input.html,
              mode: resolveHtmlMode(input.html, input.mode),
              scheme: input.scheme ?? "dark",
            },
            signal,
          );
          return {
            content: [
              {
                type: "text",
                text: layout.length
                  ? `${result.report}\nhtml_render would refuse this page:\n${layout.join("\n")}`
                  : result.report,
              },
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
