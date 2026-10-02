import { performance } from "node:perf_hooks";
import type { DiffResult } from "@ace/git";
import { ReviewAnchor } from "@ace/protocol";
import { reanchorComments } from "../src/index.ts";
const old = Array.from({ length: 10_000 }, (_, n) => `const value${n} = old;`);
const body = old.flatMap((line, n) =>
  n % 10 === 0 ? ["-" + line, "+" + line.replace("old", "new")] : [" " + line],
);
const diff: DiffResult = {
  entries: [{ path: "file.ts", status: "M", additions: 1000, deletions: 1000, binary: false }],
  patch: "--- a/file.ts\n+++ b/file.ts\n@@ -1,10000 +1,10000 @@\n" + body.join("\n") + "\n",
  truncated: false,
};
const anchors = Array.from({ length: 1000 }, (_, n) => {
  const offset = n * 10;
  return ReviewAnchor.parse({
    position: { file: "file.ts", side: "new", start: offset + 1, end: offset + 1 },
    revision: { kind: "commit", ref: "old" },
    state: "active",
    fingerprint: {
      before: old.slice(Math.max(0, offset - 3), offset),
      lines: old.slice(offset, offset + 1),
      after: old.slice(offset + 1, offset + 4),
    },
  });
});
const scattered: DiffResult = {
  ...diff,
  patch:
    "--- a/file.ts\n+++ b/file.ts\n" +
    Array.from({ length: 1000 }, (_, n) => {
      const offset = n * 10;
      return (
        `@@ -${offset + 1},10 +${offset + 1},10 @@\n` +
        old
          .slice(offset, offset + 10)
          .flatMap((line, i) =>
            i === 0 ? ["-" + line, "+" + line.replace("old", "new")] : [" " + line],
          )
          .join("\n") +
        "\n"
      );
    }).join(""),
};
for (const [workload, transition] of [
  ["single-hunk", diff],
  ["1000-hunks", scattered],
] as const) {
  for (let n = 0; n < 5; n++) reanchorComments(anchors, transition, { kind: "commit", ref: "new" });
  const iterations = 20;
  const start = performance.now();
  let pending = 0;
  for (let n = 0; n < iterations; n++)
    pending = reanchorComments(anchors, transition, { kind: "commit", ref: "new" }).filter(
      (a) => a.state === "addressed-pending-review",
    ).length;
  const ms = (performance.now() - start) / iterations;
  console.log(
    JSON.stringify({
      workload,
      comments: 1000,
      diffLines: 10_000,
      pending,
      millisecondsPerBatch: ms,
      microsecondsPerComment: ms,
      commentsPerSecond: 1_000_000 / ms,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
}
