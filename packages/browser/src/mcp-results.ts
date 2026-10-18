import { z } from "zod";
import { BrowserDialog, type BrowserState } from "@ace/protocol";
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

/** What an agent needs from the page state: where it is, who controls it, and its tabs. */
export function pageSummary(state: BrowserState) {
  const active = state.tabs?.find((tab) => tab.tabId === state.activeTabId);
  return {
    url: state.url,
    ...(active?.title ? { title: active.title } : {}),
    controller: state.controller,
    ...(state.loading ? { loading: true } : {}),
    ...(state.loadError ? { loadError: state.loadError } : {}),
    ...(state.blocked ? { blocked: state.blocked } : {}),
    ...(state.pageStateLost ? { pageStateLost: true } : {}),
    ...(state.pending_dialog ? { pending_dialog: state.pending_dialog } : {}),
    // One tab is the common case; listing it again only costs tokens.
    ...(state.tabs && state.tabs.length > 1
      ? {
          activeTabId: state.activeTabId,
          tabs: state.tabs.map((tab) => ({ tabId: tab.tabId, url: tab.url, title: tab.title })),
        }
      : {}),
  };
}

const Snapshot = z.object({
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
  const lines = [snapshot.url ? `Page: ${snapshot.url}` : "", renderSnapshot(snapshot.nodes)];
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
