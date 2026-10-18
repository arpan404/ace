import * as z from "zod/mini";
import type { HtmlVisualization } from "@ace/protocol";
import type { OpenRequest, WorkspaceTab } from "@/lib/workspace/index.ts";

/** A visualization tab's page, kept in local storage: decoded before it reaches a read. */
export const VisualizationTabData = z.object({
  sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  bytes: z.number().check(z.int(), z.gte(1)),
  title: z.string().check(z.minLength(1), z.maxLength(160)),
  mode: z.optional(z.enum(["interactive", "static"])),
});
export type VisualizationTabData = z.infer<typeof VisualizationTabData>;

export const visualizationTabKind = "visualization";

/**
 * The side panel tab that shows a published page at the panel's full size: one tab per page, so
 * expanding it again shows the tab already open.
 */
export function visualizationTab(visualization: HtmlVisualization): OpenRequest {
  const data: VisualizationTabData = {
    sha256: visualization.document.sha256,
    bytes: visualization.document.bytes,
    title: visualization.title,
    ...(visualization.mode ? { mode: visualization.mode } : {}),
  };
  return { kind: visualizationTabKind, id: data.sha256, title: data.title, data };
}

export function visualizationTabData(tab: WorkspaceTab): VisualizationTabData | undefined {
  const parsed = VisualizationTabData.safeParse(tab.data);
  return parsed.success ? parsed.data : undefined;
}
