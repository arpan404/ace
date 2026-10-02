import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createWorkspace } from "../src/index.ts";

// Timing observations only. Run identical datasets with each real backend.
const lineRoot = await mkdtemp(join(tmpdir(), "ace-workspace-line-bench-"));
const root = await mkdtemp(join(tmpdir(), "ace-workspace-search-bench-"));
try {
  await Promise.all(
    Array.from({ length: 300 }, (_, index) =>
      writeFile(join(root, `${String(index).padStart(3, "0")}.ts`), "needle\n"),
    ),
  );
  for (const ripgrep of ["rg", null]) {
    const service = await createWorkspace(root, { ripgrep });
    const start = performance.now();
    const result = await service.search({ query: "needle", glob: "*.ts", limit: 10_000 });
    console.log(
      JSON.stringify({
        dataset: "300 small files",
        backend: result.backend,
        milliseconds: performance.now() - start,
        matches: result.matches.length,
      }),
    );
    const lines = await createWorkspace(lineRoot, { ripgrep });
    for (const occurrences of [2000, 4000, 8000, 10_000]) {
      await writeFile(join(lineRoot, "sparse"), ("α" + "x".repeat(79) + "hit").repeat(occurrences));
      const lineStart = performance.now();
      const lineResult = await lines.search({ query: "hit", glob: "sparse", limit: 10_000 });
      console.log(
        JSON.stringify({
          dataset: "84 bytes per occurrence",
          occurrences,
          backend: lineResult.backend,
          milliseconds: performance.now() - lineStart,
          matches: lineResult.matches.length,
        }),
      );
    }
  }
} finally {
  await Promise.all([root, lineRoot].map((dir) => rm(dir, { recursive: true, force: true })));
}
