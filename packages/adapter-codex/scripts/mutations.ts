import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const directory = fileURLToPath(new URL("../", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const cases = [
  {
    name: "omit surviving-shell promotion",
    file: "translate-turn.ts",
    before: 'open.data["type"] === "commandExecution"',
    after: 'open.data["type"] === "never"',
    test: "translator.test.ts",
  },
  {
    name: "discard buffered child frames",
    file: "agent-registry.ts",
    before: "const buffered = agent.buffer.splice(0);",
    after: "const buffered = agent.buffer.splice(0, 0);",
    test: "translator.test.ts",
  },
  {
    name: "make async questions blocking",
    file: "translate-item.ts",
    before: "blocking: false,",
    after: "blocking: true,",
    test: "translator.test.ts",
  },
  {
    name: "omit orphan question item synthesis",
    file: "interactions.ts",
    before: "if (item && !knownItem)",
    after: "if (item && knownItem)",
    test: "translator.test.ts",
  },
  {
    name: "omit plan review",
    file: "translate-turn.ts",
    before: 'agent.mode === "plan"',
    after: 'agent.mode === "never"',
    test: "fixtures.test.ts",
  },
  {
    name: "leave completed background shells live",
    file: "translate-item.ts",
    before: "if (complete && tasks.has(shellKey(itemId)))",
    after: "if (!complete && tasks.has(shellKey(itemId)))",
    test: "fixtures.test.ts",
  },
  {
    name: "drop original native tool inputs",
    file: "translate-item.ts",
    before: "if (previous && complete)",
    after: "if (previous && !complete)",
    test: "partial-stream.test.ts",
  },
  {
    name: "reopen plan reviews on replayed boundaries",
    file: "translate-turn.ts",
    before: "if (agent.ended.has(turnId)) return;",
    after: "if (agent.ended.has(turnId)) agent.ended.delete(turnId);",
    test: "partial-stream.test.ts",
  },
  {
    name: "replace the offered approval amendment with accept",
    file: "resolution.ts",
    before: "return { decision };",
    after: 'return { decision: "accept" };',
    test: "session.test.ts",
  },
  {
    name: "steer input that was requested as queue delivery",
    file: "session-commands.ts",
    before: '"thread/queue/add",',
    after: '"turn/steer",',
    test: "session.test.ts",
  },
];
for (const mutation of cases) {
  const path = `${directory}src/${mutation.file}`;
  const original = readFileSync(path, "utf8");
  if (!original.includes(mutation.before))
    throw new Error(`Mutation target not found: ${mutation.name}`);
  try {
    writeFileSync(path, original.replace(mutation.before, mutation.after));
    const result = spawnSync(
      "bun",
      ["run", "test", `packages/adapter-codex/src/${mutation.test}`],
      { cwd: repository, encoding: "utf8" },
    );
    if (result.status !== 1 || !result.stdout.includes("failed"))
      throw new Error(
        `Mutation was not caught: ${mutation.name}\n${result.stdout}\n${result.stderr}`,
      );
    const failures = result.stdout
      .split("\n")
      .filter((line) => line.includes("× "))
      .map((line) => line.trim());
    process.stdout.write(`${mutation.name}: rejected\n${failures.join("\n")}\n`);
  } finally {
    writeFileSync(path, original);
  }
}
