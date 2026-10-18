import type { CompactNode } from "./snapshot-compact.ts";

const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** One line per node, e.g. `- button "Save" [disabled] [ref=e3-41]` or `- textbox "Email" [ref=e3-9]: ada@x`. */
export function snapshotLine(node: CompactNode, indent = node.depth): string {
  const pad = "  ".repeat(indent);
  if (node.role === "text") return `${pad}- text: ${node.name}`;
  let line = `${pad}- ${node.role}`;
  if (node.name) line += ` ${quote(node.name)}`;
  for (const state of node.states ?? []) line += ` [${state}]`;
  if (node.ref) line += ` [ref=${node.ref}]`;
  if (node.value !== undefined) line += `: ${node.value}`;
  return line;
}

/** Indented text for the whole snapshot; nodes from a child frame sit under a frame header. */
export function renderSnapshot(nodes: readonly CompactNode[]): string {
  const lines: string[] = [];
  let frame: string | undefined;
  for (const node of nodes) {
    if (node.frameId !== frame) {
      frame = node.frameId;
      if (frame) lines.push(`- frame [frame=${frame}]`);
    }
    lines.push(snapshotLine(node, node.depth + (frame ? 1 : 0)));
  }
  return lines.join("\n");
}
