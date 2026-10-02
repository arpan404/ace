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
    before: "const buffered = config.takeBuffer(agent);",
    after: "const buffered: Frame[] = [];",
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
  {
    name: "ignore provider failure text",
    file: "translate-turn.ts",
    before: "current && agent.failureText",
    after: "false && agent.failureText",
    test: "translator.test.ts",
  },
  {
    name: "keep retry after provider activity",
    file: "translate-item.ts",
    before: 'facts.push({ type: "retry.cleared", agent: agent.key });',
    after: "// retry intentionally retained",
    test: "translator.test.ts",
  },
  {
    name: "steer the wrong turn",
    file: "session-commands.ts",
    before: "expectedTurnId: turn",
    after: 'expectedTurnId: "wrong"',
    test: "session.test.ts",
  },
  {
    name: "skip cascade child interruption",
    file: "session-commands.ts",
    before: "targets.add(child);",
    after: "targets.add(thread);",
    test: "session.test.ts",
  },
  {
    name: "skip terminal termination",
    file: "session-commands.ts",
    before: '"thread/backgroundTerminals/terminate",',
    after: '"thread/backgroundTerminals/list",',
    test: "session.test.ts",
  },
  {
    name: "zero native queue count",
    file: "session.ts",
    before: "count: [...queueCounts.values()].reduce((total, value) => total + value, 0),",
    after: "count: 0,",
    test: "review-session.test.ts",
  },
  {
    name: "skip loaded descendant hydration",
    file: "session.ts",
    before: 'if (typeof entry === "string" && !known.has(entry)) await readThread(entry);',
    after: "if (false) await readThread(str(entry));",
    test: "session.test.ts",
  },
  {
    name: "corrupt user image URL",
    file: "item.ts",
    before: 'url: str(p["url"])',
    after: 'url: "corrupted"',
    test: "review-translator.test.ts",
  },
  {
    name: "drop malformed primitive frames",
    file: "translator.ts",
    before: "return handle(frame, now);",
    after:
      'if (frame.data === null || typeof frame.data !== "object" || Array.isArray(frame.data)) return []; return handle(frame, now);',
    test: "review-translator.test.ts",
  },
  {
    name: "replace usage with an invalid signal",
    file: "translator.ts",
    before: 'type: "usage",',
    after: 'type: "signal",',
    test: "review-translator.test.ts",
  },
  {
    name: "discard historical turns",
    file: "agent-registry.ts",
    before: 'const turns = list(p["turns"]);',
    after: "const turns: unknown[] = [];",
    test: "review-translator.test.ts",
  },
  {
    name: "omit usage facts",
    file: "translator.ts",
    before: 'method === "thread/tokenUsage/updated") {',
    after: 'method === "never/tokenUsage/updated") {',
    test: "review-translator.test.ts",
  },
  {
    name: "disable async free text",
    file: "native.ts",
    before: 'allowOther: async || q["isOther"] === true,',
    after: "allowOther: false,",
    test: "translator.test.ts",
  },
  {
    name: "launch help instead of app-server",
    file: "session.ts",
    before: 'args: ["app-server"],',
    after: 'args: ["--help"],',
    test: "session.test.ts",
  },
  {
    name: "retain an unlimited per-thread replay buffer",
    file: "retention.ts",
    before: "agent.buffer.length > 64",
    after: "agent.buffer.length > 64000",
    test: "streaming.test.ts",
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
