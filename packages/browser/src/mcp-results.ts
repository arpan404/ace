import { z } from "zod";
import { BrowserDialog, type BrowserState, type BrowserTab } from "@ace/protocol";
import type { CompactNode } from "./snapshot-compact.ts";
import { renderSnapshot, snapshotLine } from "./snapshot-text.ts";

export type ToolContent = { type: "text"; text: string } | Record<string, unknown>;
export interface ToolResult {
  content: ToolContent[];
}
export const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
export const json = (value: unknown): ToolResult => text(JSON.stringify(value ?? null));

const Pending = z.object({ pending_dialog: BrowserDialog });
/** A pending dialog blocks every command until answered; say how to answer it. */
export function pendingDialog(raw: unknown): ToolResult | undefined {
  const pending = Pending.safeParse(raw);
  if (!pending.success) return undefined;
  return json({
    pending_dialog: pending.data.pending_dialog,
    hint: 'A page dialog is open. Answer it with browser_act {action:"dialog", dialogId, accept}.',
  });
}

/** One tab as an agent reads it: who opened and drives it, and whether a person holds it. */
export function tabEntry(tab: BrowserTab & { current?: boolean | undefined }) {
  return {
    tabId: tab.tabId,
    url: tab.url,
    title: tab.title,
    ...(tab.label ? { label: tab.label } : {}),
    ...(tab.current ? { current: true } : {}),
    ...(tab.openedBy ? { openedBy: tab.openedBy } : {}),
    ...(tab.drivenBy ? { drivenBy: tab.drivenBy } : {}),
    // Agents act unless a person holds the tab; only say so when one does.
    ...(tab.lease && tab.lease.controller === "human" ? { lease: tab.lease } : {}),
    ...(tab.lifecycle && tab.lifecycle !== "live" ? { lifecycle: tab.lifecycle } : {}),
    ...(tab.loading ? { loading: true } : {}),
    ...(tab.pending_dialog ? { pending_dialog: tab.pending_dialog } : {}),
  };
}

/**
 * What an agent needs after opening: the tab it works in, where that tab is, whether the
 * person sees or holds it, and the other tabs when there are any.
 */
export function pageSummary(
  state: BrowserState,
  tab: { tabId: string; url: string; title: string },
) {
  const entry = state.tabs?.find((candidate) => candidate.tabId === tab.tabId);
  const viewed = state.activeTabId === undefined || state.activeTabId === tab.tabId;
  return {
    tabId: tab.tabId,
    url: entry?.url ?? tab.url,
    ...((entry?.title ?? tab.title) ? { title: entry?.title ?? tab.title } : {}),
    controller: entry?.lease?.controller ?? state.controller,
    ...(viewed ? { viewed: true } : {}),
    ...(entry?.loading || (viewed && state.loading) ? { loading: true } : {}),
    ...(viewed && state.loadError ? { loadError: state.loadError } : {}),
    ...(viewed && state.blocked ? { blocked: state.blocked } : {}),
    ...(viewed && state.pageStateLost ? { pageStateLost: true } : {}),
    ...(entry?.pending_dialog ? { pending_dialog: entry.pending_dialog } : {}),
    // One tab is the common case; listing it again only costs tokens.
    ...(state.tabs && state.tabs.length > 1
      ? {
          tabs: state.tabs.map((other) => ({
            tabId: other.tabId,
            // Agents never read a private tab's address or title.
            title: other.lease?.mode === "private" ? "" : other.title,
            ...(other.label ? { label: other.label } : {}),
            ...(other.openedBy ? { openedBy: other.openedBy.kind } : {}),
          })),
        }
      : {}),
  };
}

const Snapshot = z.object({
  tabId: z.string().optional(),
  url: z.string().optional(),
  nodes: z.array(
    z.object({
      ref: z.string().optional(),
      role: z.string(),
      name: z.string(),
      value: z.string().optional(),
      states: z.array(z.string()).optional(),
      depth: z.number().int().nonnegative(),
      frameId: z.string().optional(),
    }) satisfies z.ZodType<CompactNode>,
  ),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export function snapshotText(raw: unknown, scoped: boolean): ToolResult {
  const snapshot = Snapshot.parse(raw);
  // The tab id lets parallel agents confirm which tab they read.
  const tab = snapshot.tabId ? ` [tab=${snapshot.tabId}]` : "";
  const lines = [snapshot.url ? `Page: ${snapshot.url}${tab}` : "", renderSnapshot(snapshot.nodes)];
  if (!snapshot.nodes.length) lines.push("(no accessible content)");
  if (snapshot.truncated)
    lines.push(
      `[truncated: ${snapshot.nodes.length} of ${snapshot.total} nodes shown. Narrow with ${scoped ? "a smaller container ref" : "ref=<a container's ref>"}, interactiveOnly:true or browser_find, or raise maxNodes.]`,
    );
  return text(lines.filter(Boolean).join("\n"));
}
export function findText(raw: unknown): ToolResult {
  const found = Snapshot.parse(raw);
  if (!found.nodes.length)
    return text("No matching elements. Check the role and name, or call browser_snapshot.");
  const lines = found.nodes.map((node) => snapshotLine(node, 0));
  if (found.truncated) lines.push(`[${found.nodes.length} of ${found.total} matches shown]`);
  return text(lines.join("\n"));
}
