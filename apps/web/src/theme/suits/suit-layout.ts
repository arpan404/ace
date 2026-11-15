import type { SuitLayout } from "@ace/protocol/suit-parts";
import type { SuitManifest } from "@ace/protocol/suits";

/*
 * A Suit's layout (ADR 0150, "Layout") as the shell draws it: each setting from its fixed set,
 * with the fallbacks a narrow window needs. On a narrow window the sidebar is a sheet from the
 * left, the composer docks, and a hidden header shows again, since its title and the sheet's
 * toggle have nowhere else to go. Without a Suit, or a Suit without `layout`, nothing changes:
 * `resolveSuitLayout` answers null and the shell carries no layout attributes. Pure.
 */

export type ResolvedSuitLayout = Required<Pick<SuitLayout, LayoutChoice>> &
  Pick<SuitLayout, "sidebarWidth" | "transcriptWidth">;

type LayoutChoice = "sidebar" | "rail" | "composer" | "header" | "messages" | "toolRows";

export const defaultSuitLayout: ResolvedSuitLayout = {
  sidebar: "left",
  rail: "shown",
  composer: "docked",
  header: "bar",
  messages: "bubbles",
  toolRows: "compact",
};

export interface LayoutFacts {
  /** The sidebar can sit beside the column (not a sheet). */
  wide: boolean;
}

export function resolveSuitLayout(
  layout: Partial<SuitLayout> | undefined,
  facts: LayoutFacts,
): ResolvedSuitLayout | null {
  if (!layout) return null;
  const given = { ...defaultSuitLayout, ...layout };
  if (facts.wide) return given;
  return {
    ...given,
    sidebar: "left",
    composer: "docked",
    header: given.header === "hidden" ? "bar" : given.header,
  };
}

/** The shell's attributes: `data-layout-sidebar="right"` and so on, one per setting. */
export function layoutAttributes(
  layout: ResolvedSuitLayout | null,
): Record<`data-layout-${string}`, string> {
  if (!layout) return {};
  return {
    "data-layout-sidebar": layout.sidebar,
    "data-layout-rail": layout.rail,
    "data-layout-composer": layout.composer,
    "data-layout-header": layout.header,
    "data-layout-messages": layout.messages,
    "data-layout-tool-rows": layout.toolRows,
  };
}

/**
 * The reading column's width as a rule on the Suit's root, so everything that reads `--column`
 * (the transcript, the composer, the docked work card's arithmetic) follows it.
 */
export function suitLayoutStylesheet(manifest: Pick<SuitManifest, "id" | "layout">): string {
  const width = manifest.layout?.transcriptWidth;
  return width === undefined ? "" : `[data-suit="${manifest.id}"]{--column:${width}px}`;
}

/**
 * The sidebar's width: the Suit's, while the person's own is still the default (or reset to
 * it); a width they dragged to stays theirs.
 */
export function suitSidebarWidth(
  layout: ResolvedSuitLayout | null,
  stored: number,
  preferred: number,
): number {
  return layout?.sidebarWidth !== undefined && stored === preferred ? layout.sidebarWidth : stored;
}

/** The rail's own column beside the panel: none when the Suit hides it or merges it in. */
export const railColumn = (layout: ResolvedSuitLayout | null, railWidth: number) =>
  layout && layout.rail !== "shown" ? 0 : railWidth;
