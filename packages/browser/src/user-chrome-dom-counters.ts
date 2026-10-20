import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";

const Counted = z.object({ result: z.object({ value: z.number() }) });
/** Counts the document's nodes, stopping just past the snapshot limit. */
const countNodes = `(() => {
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
  let nodes = 1;
  while (nodes <= 20001 && walker.nextNode()) nodes++;
  return nodes;
})()`;

/**
 * Extensions get no Memory domain (ADR 0084); the snapshot and text-wait size guards count the
 * document's nodes instead. Every other command passes through.
 */
export function countingDomNodes(send: BrowserCdp["send"]): BrowserCdp["send"] {
  return async (method, params) => {
    if (method !== "Memory.getDOMCounters") return send(method, params);
    const counted = Counted.parse(
      await send("Runtime.evaluate", { expression: countNodes, returnByValue: true }),
    );
    return { documents: 1, nodes: counted.result.value, jsEventListeners: 0 };
  };
}
