import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { ForgeStore, LogTail, mapCheck, ReviewIndex } from "../src/index.ts";
import type { ForgePrStatus } from "@ace/protocol/forge";

const repository = { forge: "github", host: "github.com", owner: "octo", name: "ace" } as const;
const link = { threadId: "bench", pr: { repository, number: 7 } };
const check = {
  id: 1,
  name: "tests",
  status: "completed",
  conclusion: "failure",
  completed_at: "now",
  details_url: "https://github.com/octo/ace/actions/runs/1/job/2",
};
const status: ForgePrStatus = {
  ref: link.pr,
  title: "Fix",
  url: "https://github.com/octo/ace/pull/7",
  headSha: "a".repeat(40),
  state: "open",
  mergeability: "unknown",
  ci: "failure",
  checks: [mapCheck(check)],
  comments: [
    {
      kind: "inline",
      id: 1,
      body: "Fix empty input",
      author: "alice",
      file: "index.ts",
      line: 4,
      updatedAt: "now",
      replyTo: null,
    },
  ],
  reviewThreads: [],
  raw: null,
};
const ignored = new Set<string>();
let checksum = 0;
function measure(name: string, count: number, action: (index: number) => void): void {
  const start = performance.now();
  for (let index = 0; index < count; index++) action(index);
  const elapsed = performance.now() - start;
  console.log(
    JSON.stringify({
      name,
      count,
      opsPerSecond: Math.round((count / elapsed) * 1_000),
      usPerOp: +((elapsed * 1_000) / count).toFixed(2),
      peakRssMiB: +(process.resourceUsage().maxRSS / 1_024).toFixed(1),
    }),
  );
}
measure("check mapping", 100_000, () => {
  checksum += mapCheck(check).name.length;
});
const reviewIndex = new ReviewIndex({ link, generation: 1 }, ignored);
reviewIndex.update(status);
for (const candidate of reviewIndex.pending()) reviewIndex.observe(candidate.key);
measure("unchanged review index, 2 records", 1_000_000, () => {
  reviewIndex.update(status);
  checksum++;
});
const large = {
  ...status,
  checks: [],
  comments: Array.from({ length: 2_000 }, (_, index) => ({
    ...status.comments[0],
    kind: "issue" as const,
    id: index + 1,
    body: `Review ${index}`,
    author: "alice",
    file: null,
    line: null,
    updatedAt: "now",
    replyTo: null,
  })),
};
const largeIndex = new ReviewIndex({ link, generation: 1 }, ignored);
largeIndex.update(large);
for (const candidate of largeIndex.pending()) largeIndex.observe(candidate.key);
measure("unchanged review index, 2000 records", 1_000_000, () => {
  largeIndex.update(large);
  checksum++;
});
measure("metadata-only revision, 2000 unchanged records", 100_000, (index) => {
  largeIndex.update({ ...large, title: String(index) });
  checksum++;
});
const chunk = Buffer.from("compiler diagnostic line\n".repeat(2_000));
const tail = new LogTail();
measure("streaming tail, 50KB chunk", 2_000, () => {
  tail.write(chunk);
});
checksum += tail.finish().text.length;
const db = new DatabaseSync(":memory:");
const store = new ForgeStore(db);
store.link(link);
measure("SQLite intent admission and acknowledgement", 10_000, (index) => {
  const intent = {
    type: "auto-fix",
    key: String(index),
    linkGeneration: 1,
    link,
    headSha: status.headSha,
    context: { type: "review", comment: status.comments[0] },
  } as const;
  if (!intent.context.comment) throw new Error("Missing benchmark comment");
  const validIntent = {
    ...intent,
    context: { type: "review", comment: intent.context.comment },
  } as const;
  store.admit(validIntent);
  store.acknowledge(validIntent);
});
measure("SQLite duplicate lookup with 10000 delivered identities", 100_000, () => {
  checksum += Number(store.hasIntent(link.threadId, "9999"));
});
db.close();
console.log(JSON.stringify({ checksum }));
