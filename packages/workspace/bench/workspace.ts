import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createWorkspace } from "../src/index.ts";

// Non-gating measurements; no throughput or wall-clock assertion.
const root = await mkdtemp(join(tmpdir(), "ace-workspace-bench-"));
try {
  const files = 1000;
  for (let start = 0; start < files; start += 100) {
    await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        const dir = join(root, `dir-${Math.floor((start + index) / 100)}`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${start + index}.ts`), "export const needle = 1;\n".repeat(20));
      }),
    );
  }
  const service = await createWorkspace(root, { ripgrep: null });
  let acknowledge: (() => void) | undefined;
  const observed = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const start = performance.now();
  const subscription = await service.watch({
    onChange(changes) {
      if (changes.some((change) => change.path === "dir-0/0.ts" && change.kind === "changed"))
        acknowledge?.();
    },
    onWarning() {},
  });
  const setupMs = performance.now() - start;
  try {
    const changed = performance.now();
    await writeFile(join(root, "dir-0/0.ts"), "edited needle\n");
    await observed;
    const notificationMs = performance.now() - changed;
    const refresh = performance.now();
    await subscription.flush();
    const fullRefreshMs = performance.now() - refresh;
    const searching = performance.now();
    const result = await service.search({ query: "needle", limit: 100 });
    console.log(
      JSON.stringify(
        {
          files,
          watchMode: subscription.mode,
          setupMs,
          notificationMs,
          fullRefreshMs,
          nodeSearchMs: performance.now() - searching,
          matches: result.matches.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await subscription.dispose();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
