import { z } from "zod";
import { HtmlRenderInput, ItemId, type McpAttribution } from "@ace/protocol";
import { validateHtml } from "@ace/html";
import { PublicToolError } from "./public-error.ts";
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
  title: title.describe("A short caption shown above the page."),
  html: html.describe(
    "A complete self-contained HTML document: inline CSS, JS, SVG and data: images, no network.",
  ),
  height: height.describe("Frame height in CSS pixels; default fits the content."),
  mode: mode.describe(
    "interactive runs its scripts in a sandbox; static strips them (charts, diagrams). Default: inferred.",
  ),
});
export const htmlToolCatalog = [
  {
    name: "html_render",
    title: "Show an HTML visual inline",
    description:
      "Show a chart, diagram, mockup or small interactive page inline in your reply. An invalid page returns invalid_html listing every problem and publishes nothing. Design and sandbox rules: guide visualize.",
    input: RenderInput,
    output: z.object({ itemId: ItemId }),
    capability: null,
    riskClass: "thread-write",
    toolset: "visualize",
    timeoutMs: 30000,
    maxInputBytes: 2 * 1024 * 1024,
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
