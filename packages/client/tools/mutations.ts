import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const mutations = [
  {
    name: "retry cap removed",
    file: "lifecycle.ts",
    before: "Math.min(cap, base * 2 ** Math.min(attempt, 30)) * random",
    after: "base * 2 ** Math.min(attempt, 30) * random",
    test: "retry ceilings double",
  },
  {
    name: "resume cursor omitted",
    file: "subscriptions.ts",
    before: "...(entry.store.cursor === undefined ? {} : { afterSeq: entry.store.cursor }),",
    after: "...{},",
    test: "reconnect mid-stream",
  },
  {
    name: "duplicate coverage resyncs",
    file: "thread-store.ts",
    before: 'if (message.throughSeq <= view.seq) return "ignored";',
    after: 'if (message.throughSeq <= view.seq) return "gap";',
    test: "reconnect mid-stream",
  },
  {
    name: "missing coverage ignored",
    file: "thread-store.ts",
    before: 'if (message.afterSeq !== view.seq) return "gap";',
    after: 'if (message.afterSeq !== view.seq) return "ignored";',
    test: "a dropped frame",
  },
  {
    name: "request deadline reports abort",
    file: "requests.ts",
    before: '() => fail(new ClientError("timeout"))',
    after: '() => fail(new ClientError("aborted"))',
    test: "a request deadline",
  },
  {
    name: "abort reports timeout",
    file: "requests.ts",
    before: 'const abort = () => fail(new ClientError("aborted"));',
    after: 'const abort = () => fail(new ClientError("timeout"));',
    test: "abort cancels",
  },
  {
    name: "first release unsubscribes",
    file: "subscriptions.ts",
    before: "if (--owned.refs === 0)",
    after: "if (--owned.refs <= 1)",
    test: "two views keep",
  },
  {
    name: "MRU eviction replaces LRU",
    file: "subscriptions.ts",
    before: "[...this.cache].find(([, value]) => !value.refs)",
    after: "[...this.cache].toReversed().find(([, value]) => !value.refs)",
    test: "LRU retains",
  },
  {
    name: "fatal auth accepts network retries",
    file: "lifecycle.ts",
    before: 'previous === online || !active || state === "fatal"',
    after: "previous === online || !active",
    test: "an auth rejection",
  },
  {
    name: "restart drops pending replay",
    file: "intents.ts",
    before: 'if (intent.state === "pending") this.send(intent.command);',
    after: 'if (intent.state === "acked") this.send(intent.command);',
    test: "a persisted outbox",
  },
  {
    name: "delta mutates prior selected item",
    file: "thread-store.ts",
    before: "parts: item.parts.map((part) => ({ ...part }))",
    after: "parts: item.parts",
    test: "only the changed item",
  },
  {
    name: "send precedes durable write",
    file: "intents.ts",
    before: "await this.storage.save(serialized);",
    after: "this.send(command); await this.storage.save(serialized);",
    test: "a failed persistence write",
  },
];
const report: string[] = [];
for (const mutation of mutations) {
  const file = `packages/client/src/${mutation.file}`;
  const source = readFileSync(file, "utf8");
  if (!source.includes(mutation.before))
    throw new Error(`Missing mutation target: ${mutation.name}`);
  try {
    writeFileSync(file, source.replace(mutation.before, mutation.after));
    let result = spawnSync(
      "bun",
      ["run", "test", "--", "packages/client/src", "-t", mutation.test],
      { encoding: "utf8" },
    );
    if (result.status === 137)
      result = spawnSync("bun", ["run", "test", "--", "packages/client/src", "-t", mutation.test], {
        encoding: "utf8",
      });
    const output = result.stdout + result.stderr;
    if (result.status === 0 || !output.includes("FAIL") || !output.includes(mutation.test))
      throw new Error(`Mutation survived or runner failed: ${mutation.name}\n${output}`);
    report.push(`- ${mutation.name}: killed by "${mutation.test}".`);
    console.log(report.at(-1));
  } finally {
    writeFileSync(file, source);
  }
}
writeFileSync(
  "packages/client/bench/mutations.md",
  `# Mutation verification\n\nEach production mutation below caused its selected public behavior test to fail. All mutations were reverted before the final full check. Run from the repo root with \`node packages/client/tools/mutations.ts\`.\n\n${report.join("\n")}\n`,
);
