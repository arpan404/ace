import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import { outlineDomNodes } from "./snapshot-scope.ts";

const Counted = z.object({ result: z.object({ value: z.number() }) });
/**
 * Counts the document's nodes, stopping just past the snapshot's outline limit: past it the
 * snapshot outlines the page whatever the exact count, so a huge page costs no more to count.
 */
const countNodes = `(() => {
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
  let nodes = 1;
  while (nodes <= ${outlineDomNodes} && walker.nextNode()) nodes++;
  return nodes;
})()`;

/**
 * Extensions get no Memory domain (ADR 0084); the snapshot's size guard counts the document's
 * nodes instead. Those counts are per document, never shared by a process, so the
 * session names no isolate and is counted on its own. Every other command passes through.
 */
export function countingDomNodes(send: BrowserCdp["send"]): BrowserCdp["send"] {
  return async (method, params) => {
    if (method === "Runtime.getIsolateId") throw new Error("Counters here are per document");
    if (method !== "Memory.getDOMCounters") return send(method, params);
    const counted = Counted.parse(
      await send("Runtime.evaluate", { expression: countNodes, returnByValue: true }),
    );
    return { documents: 1, nodes: counted.result.value, jsEventListeners: 0 };
  };
}
