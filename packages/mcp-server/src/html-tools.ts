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
      'Show a self-contained HTML page (inline CSS, JS, SVG and data: images; no network) inline in your reply. mode "interactive" runs its scripts in a sandbox; "static" strips them and suits charts and diagrams. An invalid page returns invalid_html listing every problem and publishes nothing. Design and sandbox rules: ace_guide visualize.',
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
