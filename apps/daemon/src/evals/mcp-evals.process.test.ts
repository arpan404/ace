import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  claudeInjection,
  codexInjection,
  cursorSdkInjection,
  developerInstructions,
  openCodeInjection,
} from "@ace/mcp-server";
import { evalTasks as coreTasks } from "./tasks.ts";
import { knowledgeTasks } from "./tasks-knowledge.ts";

const evalTasks = [...coreTasks, ...knowledgeTasks];
import { evalWorld } from "./world.ts";
import { measureCatalogue, renderMarkdown, type CatalogueMetrics, type TaskRow } from "./report.ts";

// Tier A of the MCP eval harness (docs/evals/mcp/README.md): deterministic, no provider calls.
// `bun run eval:mcp` sets ACE_EVAL_REPORT to write the JSON and markdown report.
const rows: TaskRow[] = [];
let catalogue: CatalogueMetrics | undefined;

for (const task of evalTasks)
  test(`${task.gate ? "[gate] " : ""}${task.title}`, async () => {
    const world = await evalWorld({ browser: task.needsBrowser ?? false });
    try {
      if (task.needsBrowser && !world.browser) {
        rows.push({ id: task.id, title: task.title, gate: task.gate, note: "no Chromium here" });
        return;
      }
      const outcome = await task.run(world);
      rows.push({ id: task.id, title: task.title, gate: task.gate, ...outcome });
      if (task.gate) expect(outcome.metrics.success, outcome.note).toBe(true);
    } finally {
      await world.close();
    }
  });

test("catalogue a full-access thread sees", async () => {
  const world = await evalWorld({ browser: true });
  try {
    const { agent, connection } = await world.agent({});
    const server = agent.serverInstructions;
    const withServer = (native: string) => Buffer.byteLength(`${server}\n\n${native}`);
    catalogue = measureCatalogue(agent.tools, {
      claude: withServer(claudeInjection(connection).developerInstructions),
      codex: Buffer.byteLength(codexInjection(connection).developerInstructions),
      opencode: withServer(openCodeInjection(connection).developerInstructions),
      cursor: (() => {
        const cursor = cursorSdkInjection(connection);
        // Cursor reads server instructions unless ace opts it out with this header.
        return Object.entries(cursor.mcpServers.ace.headers).some(
          ([name, value]) => name === "X-Ace-Instructions" && value === "native",
        )
          ? Buffer.byteLength(cursor.developerInstructions)
          : withServer(cursor.developerInstructions);
      })(),
      pi: Buffer.byteLength(developerInstructions("pi")),
      acp: withServer(developerInstructions("acp")),
    });
    expect(catalogue.tools).toBeGreaterThan(0);
  } finally {
    await world.close();
  }
});

afterAll(() => {
  const target = process.env["ACE_EVAL_REPORT"];
  if (!target) return;
  const order = new Map(evalTasks.map((task, index) => [task.id, index]));
  const report = {
    label: process.env["ACE_EVAL_LABEL"] ?? "latest",
    tasks: rows.toSorted((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
    catalogue,
  };
  const stem = resolve(new URL("../../../../", import.meta.url).pathname, target);
  mkdirSync(dirname(stem), { recursive: true });
  writeFileSync(`${stem}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${stem}.md`, renderMarkdown(report));
});
