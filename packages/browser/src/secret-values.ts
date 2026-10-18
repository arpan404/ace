import { z } from "zod";
import { maskedSecretValue, secretFieldSelector } from "@ace/browser-annotate";
import type { BrowserCdp } from "./backend.ts";
import type { AXTree } from "./cdp.ts";

type Tree = z.infer<typeof AXTree>;

const Listed = z.object({ result: z.object({ objectId: z.string().optional() }) });
const Properties = z.object({
  result: z.array(
    z.object({ name: z.string(), value: z.object({ objectId: z.string().optional() }).optional() }),
  ),
});
const Described = z.object({ node: z.object({ backendNodeId: z.number().int() }) });
/** More secret fields than any real form has; the rest of a pathological page goes unmasked. */
const secretLimit = 256;
const group = "ace-secret-fields";

/**
 * Backend node ids of the secret fields (passwords, one-time codes, card numbers) in the
 * session's document and its same-origin frames. Work is proportional to the fields found.
 */
export async function secretFieldNodes(cdp: BrowserCdp): Promise<Set<number>> {
  const ids = new Set<number>();
  try {
    const listed = Listed.parse(
      await cdp.send("Runtime.evaluate", {
        expression: `(() => { const found = []; const visit = (doc, depth) => {
          for (const field of doc.querySelectorAll(${JSON.stringify(secretFieldSelector)})) {
            if (found.length >= ${secretLimit}) return; found.push(field); }
          if (depth < 8) for (const frame of doc.querySelectorAll("iframe, frame")) {
            try { if (frame.contentDocument) visit(frame.contentDocument, depth + 1); } catch {} }
        }; visit(document, 0); return found; })()`,
        returnByValue: false,
        objectGroup: group,
        silent: true,
      }),
    );
    const objectId = listed.result.objectId;
    if (!objectId) return ids;
    const properties = Properties.parse(
      await cdp.send("Runtime.getProperties", { objectId, ownProperties: true }),
    );
    for (const property of properties.result) {
      const element = property.value?.objectId;
      if (!/^\d+$/.test(property.name) || !element) continue;
      const described = Described.safeParse(
        await cdp.send("DOM.describeNode", { objectId: element }),
      );
      if (described.success) ids.add(described.data.node.backendNodeId);
    }
  } finally {
    await cdp.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
  }
  return ids;
}

/**
 * Blanks secret fields in an accessibility tree: the field's value, and every name and value in
 * its subtree (a "show password" field's inner text), read the same whatever was typed. The tree
 * was parsed for this snapshot alone, so it is changed in place.
 */
export function maskSecretFields(tree: Tree, secrets: ReadonlySet<number>): Tree {
  if (!secrets.size) return tree;
  const byId = new Map(tree.nodes.map((node) => [node.nodeId, node]));
  const pending = tree.nodes
    .filter((node) => node.backendDOMNodeId !== undefined && secrets.has(node.backendDOMNodeId))
    .map((node) => ({ node, root: true }));
  const seen = new Set<string>();
  while (pending.length) {
    const next = pending.pop();
    if (!next || seen.has(next.node.nodeId)) continue;
    seen.add(next.node.nodeId);
    const { node } = next;
    if (node.value && String(node.value.value ?? "") !== "")
      node.value = { value: maskedSecretValue };
    if (!next.root && node.name) node.name = { value: "" };
    for (const child of node.childIds ?? []) {
      const found = byId.get(child);
      if (found) pending.push({ node: found, root: false });
    }
  }
  return tree;
}
