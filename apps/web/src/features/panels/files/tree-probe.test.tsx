import { test, expect } from "vitest";
import { renderTree } from "./tree-test-support.tsx";
test("probe 1", async () => { const t0=performance.now(); const { tree } = await renderTree(); console.log("first", performance.now()-t0); expect(tree).toBeTruthy(); });
test("probe 2", async () => { const t0=performance.now(); const { tree } = await renderTree(); console.log("second", performance.now()-t0); expect(tree).toBeTruthy(); });
