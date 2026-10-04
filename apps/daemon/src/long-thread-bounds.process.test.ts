import { expect, test } from "vitest";
import { Agent } from "@ace/protocol";
import { storeFixture, root, start, tool, turns } from "./long-thread-test-support.ts";

// Mutations: budgeting strings by character count, letting the first oversized turn bypass
// the byte budget, dropping counters when omitting detail. Not executed (tests run at merge).
test("a turn with long UTF-8 paths, commands and child names fits the wire budget while retaining counts", () => {
  const f = storeFixture();
  start(f.store, f.thread, "large-summary", 20);
  for (let index = 0; index < 64; index++) {
    f.store.appendEvents(
      f.thread.id,
      [
        {
          type: "item.created",
          item: tool(
            `wide-file-${index}`,
            "succeeded",
            {
              kind: "file.write",
              changes: [
                { path: `${"界".repeat(4090)}${index}.ts`, kind: "add", newText: "line\n" },
              ],
            },
            "large-summary",
          ),
        },
        {
          type: "item.created",
          item: tool(
            `wide-command-${index}`,
            "succeeded",
            { kind: "shell", command: `${"界".repeat(1000)} command ${index}`, exitCode: 0 },
            "large-summary",
          ),
        },
      ],
      30,
    );
  }
  for (let index = 0; index < 32; index++) {
    f.store.appendEvents(
      f.thread.id,
      [
        {
          type: "agent.created",
          agent: Agent.parse({
            id: `wide-child-${index}`,
            threadId: f.thread.id,
            parentId: root,
            origin: "provider_subagent",
            fidelity: "summary",
            name: "界".repeat(1024),
            native: { provider: "codex" },
            cwd: f.home,
            status: { state: "idle" },
            createdAt: 40,
          }),
        },
      ],
      40,
    );
  }
  const page = turns(f.store, f.thread, { limit: 1 });
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024 * 1024);
  expect(page.turns).toHaveLength(1);
  expect(page.turns[0]?.digest).toMatchObject({
    toolCounts: { "file.write": 64, shell: 64 },
    commandsRun: 64,
    commandsFailed: 0,
    subagentsStarted: 32,
    subagentsFinished: 32,
    truncated: true,
  });
  expect(page.turns[0]?.subagents).toHaveLength(32);
});
