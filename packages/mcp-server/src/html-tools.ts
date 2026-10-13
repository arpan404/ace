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
export const htmlToolCatalog = [
  {
    name: "ace_html_render",
    description:
      'Publish a self-contained HTML page inline in your reply, at full message width. Choose mode per page: "interactive" for something the user manipulates (sliders, step-throughs, quizzes, simulations); its inline scripts run in a sandbox with no network or app access. "static" for read-only explanations, charts and diagrams; scripts are stripped, it is lighter, and it loses nothing when scrolled away. Omitted: static when the page has no script, otherwise interactive. Inline CSS/JS/SVG and data: images only; use the theme CSS variables. The page is validated first: external resources, frames, forms and links are refused with an invalid_html error listing each problem, and nothing is published. Optional max height is 80–2000 CSS pixels. Maximum 256 KiB UTF-8.',
    input: HtmlRenderInput,
    output: z.object({ itemId: ItemId }),
    capability: null,
    riskClass: "thread-write",
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
