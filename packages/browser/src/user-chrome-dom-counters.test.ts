import { expect, it } from "vitest";
import type { BrowserCdp } from "./backend.ts";
import { pageDomNodes } from "./page-dom-nodes.ts";
import { outlineDomNodes } from "./snapshot-scope.ts";
import { countingDomNodes } from "./user-chrome-dom-counters.ts";

/**
 * A tab in the person's Chrome whose document has `nodes` nodes: `Runtime.evaluate` runs the
 * expression it is sent against that document. `walked` counts the nodes the count visited.
 */
function extensionTab(nodes: number) {
  const visits = { walked: 0 };
  const document = {
    createTreeWalker: () => {
      let left = nodes - 1;
      return {
        nextNode: () => {
          visits.walked++;
          return left-- > 0 ? {} : null;
        },
      };
    },
  };
  const send = async (method: string, params?: Record<string, unknown>) => {
    if (method !== "Runtime.evaluate") throw new Error(`unexpected ${method}`);
    const run = new Function("document", "NodeFilter", `return ${String(params?.["expression"])}`);
    return { result: { value: run(document, { SHOW_ALL: 0xffffffff }) as number } };
  };
  const cdp: BrowserCdp = { send: countingDomNodes(send), on: () => {}, off: () => {} };
  return { cdp, visits };
}

it("an extension tab above the snapshot's outline limit counts as above it", async () => {
  const { cdp } = extensionTab(outlineDomNodes + 10_000);
  expect(await pageDomNodes([cdp])).toBeGreaterThan(outlineDomNodes);
});

it("an extension tab below the limit counts exactly, and a huge one stops just past it", async () => {
  expect(await pageDomNodes([extensionTab(300).cdp])).toBe(300);
  const huge = extensionTab(1_000_000);
  expect(await pageDomNodes([huge.cdp])).toBeGreaterThan(outlineDomNodes);
  expect(huge.visits.walked).toBeLessThanOrEqual(outlineDomNodes + 1);
});
