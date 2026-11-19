import { expect, it } from "vitest";
import type { BrowserCdp } from "./backend.ts";
import { pageDomNodes } from "./page-dom-nodes.ts";

/** A frame session whose renderer process reports `nodes` for every frame it holds. */
function session(isolate: string | undefined, nodes: number): BrowserCdp {
  return {
    send: async (method) => {
      if (method === "Runtime.getIsolateId") {
        if (isolate === undefined) throw new Error("not supported");
        return { id: isolate };
      }
      if (method === "Memory.getDOMCounters") return { documents: 1, nodes, jsEventListeners: 0 };
      throw new Error(`unexpected ${method}`);
    },
    on: () => {},
    off: () => {},
  };
}

it("same-site frames that share a renderer process count its nodes once", async () => {
  const top = session("top", 200);
  const frames = Array.from({ length: 32 }, () => session("shared", 7_500));
  expect(await pageDomNodes([top, ...frames])).toBe(7_700);
});

it("frames in separate processes, or that cannot name one, each count", async () => {
  const top = session("top", 200);
  const same = session("top", 200);
  expect(await pageDomNodes([top, top, same, session("a", 30), session(undefined, 5)])).toBe(235);
});
