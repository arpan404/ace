import { z } from "zod";
import { HtmlRenderInput, ItemId, type McpAttribution } from "@ace/protocol";
import { validateHtml } from "@ace/html";
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
const { title, html, height, mode } = HtmlRenderInput.shape;
const RenderInput = HtmlRenderInput.extend({
  title: title.describe("Caption above the page."),
  html: html.describe(
    "A self-contained HTML document: inline CSS, JS, SVG and data: images; no network.",
  ),
  height: height.describe("CSS pixels held while loading; the frame then fits the page."),
  mode: mode.describe(
    "interactive runs scripts in a sandbox; static strips them. Default: inferred.",
  ),
});
export const htmlToolCatalog = [
  {
    name: "html_render",
    title: "Show an HTML visual inline",
    description:
      "Show a chart, diagram, mockup or interactive page inline in your reply. Read guide visualize first and follow it. invalid_html lists every problem; nothing is published.",
    input: RenderInput,
    output: z.object({ itemId: ItemId }),
    capability: null,
    riskClass: "thread-write",
    toolset: "visualize",
    timeoutMs: 30000,
    maxInputBytes: maxHtmlInputBytes,
  },
] as const;
export function htmlToolkit(port: HtmlPublicationPort): Toolkit {
  return {
    register(registry) {
      registry.register({
        ...htmlToolCatalog[0],
        async run(input, { caller, signal }) {
          const diagnostics = validateHtml(input.html);
          // One call: an invalid page comes back with every problem instead of needing a preview.
          if (!diagnostics.valid)
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
          return port.publish(caller, input, signal);
        },
      });
    },
  };
}
