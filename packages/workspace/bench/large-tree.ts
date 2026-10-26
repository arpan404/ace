import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createWorkspace } from "../src/index.ts";

// Report-only timings for a generated 20,000-file tree: a full inventory, one listing page,
// then a search that reads every file. No threshold; the Windows suite carries the bounded case.
const root = await mkdtemp(join(tmpdir(), "ace-workspace-large-bench-"));
try {
  const directories = 200;
  for (let d = 0; d < directories; d++) {
    const dir = join(root, `pkg${d}`);
    await mkdir(dir);
    await Promise.all(
      Array.from({ length: 100 }, (_, f) =>
        writeFile(join(dir, `f${f}.ts`), f === 0 ? "export const needle = 1;\n" : "export {};\n"),
      ),
    );
  }
  const service = await createWorkspace(root, { ripgrep: null });
  // A watch subscription reads the whole visible tree once; list pages re-walk from the start.
  const listing = performance.now();
  const subscription = await service.watch({ onChange() {}, onWarning() {} });
  const inventoryMs = performance.now() - listing;
  await subscription.dispose();
  const firstPage = performance.now();
  const entries = (await service.list({ dir: "", depth: 2, limit: 1000 })).entries.length;
  const firstPageMs = performance.now() - firstPage;
  const searching = performance.now();
  const result = await service.search({ query: "needle", limit: 10_000 });
  const searchMs = performance.now() - searching;
  console.log(
    JSON.stringify({
      dataset: "20,000 files in 200 folders",
      platform: process.platform,
      arch: process.arch,
      inventoryMs,
      firstPageEntries: entries,
      firstPageMs,
      searchMs,
      matches: result.matches.length,
      bytesScanned: result.bytesScanned,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
