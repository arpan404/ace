import { z } from "zod";
import {
  HtmlPreviewInput,
  HtmlRenderInput,
  HtmlDiagnostics,
  ItemId,
  type McpAttribution,
} from "@ace/protocol";
import { validateHtml } from "@ace/html";
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
    name: "ace_html_preview",
    description:
      "Validate a self-contained HTML visualization without publishing or executing it. Returns UTF-8 size and unsupported-feature diagnostics. Fix errors before ace_html_render; authored scripts and event handlers render as static content.",
    input: HtmlPreviewInput,
    output: HtmlDiagnostics,
    capability: null,
    riskClass: "read-only",
    timeoutMs: 10000,
    maxInputBytes: 2 * 1024 * 1024,
  },
  {
    name: "ace_html_render",
    description:
      "Publish a durable HTML visualization in the calling thread above your next reply. Preview first. Use static HTML, inline CSS, SVG and embedded data images; authored scripts and event handlers do not execute. No external requests. Optional height is 80–2000 CSS pixels. Maximum HTML size is 256 KiB UTF-8.",
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
        async run(input) {
          return validateHtml(input.html);
        },
      });
      registry.register({
        ...htmlToolCatalog[1],
        async run(input, { caller, signal }) {
          const diagnostics = validateHtml(input.html);
          if (!diagnostics.valid)
            throw new Error("Invalid HTML. Call ace_html_preview for diagnostics.");
          return port.publish(caller, input, signal);
        },
      });
    },
  };
}
