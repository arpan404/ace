import { performance } from "node:perf_hooks";
import { Agent, Interaction, type AgentStatus } from "@ace/protocol";
import { agentForest, type ThreadWork } from "../src/agent-forest.ts";
import { summaryAgents } from "../src/summary-agents.ts";

/*
 * The phone Summary's grouping (`summaryAgents`) over two shapes that grow: a wide tree whose
 * every agent has a request pending, and one long chain of subagents. Linear work grows with the
 * size; scanning the requests per row, or the ancestors per row, grows with its square. Run:
 * bun run --cwd packages/ui-core bench.
 */

const working: AgentStatus = { state: "working", activity: "tool" };
const sizes = [250, 500, 1000, 2000, 4000];
const median = (runs: number[]) =>
  runs.toSorted((left, right) => left - right)[runs.length >> 1] ?? 0;

const make = (id: string, parentId: string | null, at: number) =>
  Agent.parse({
    id,
    parentId,
    threadId: "t",
    origin: parentId ? "ace" : "root",
    native: { provider: "claude", nativeId: id },
    fidelity: "full",
    cwd: "/project",
    status: working,
    createdAt: at,
  });

/** `size` subagents under the main agent, each with a question pending. */
function wide(size: number): Map<string, ThreadWork> {
  const agents = [make("root", null, 0)];
  const interactions: Interaction[] = [];
  for (let index = 0; index < size; index++) {
    agents.push(make(`a${index}`, "root", index + 1));
    interactions.push(
      Interaction.parse({
        id: `ask${index}`,
        threadId: "t",
        agentId: `a${index}`,
        blocking: true,
        state: "pending",
        createdAt: index,
        request: { kind: "question", questions: [] },
      }),
    );
  }
  return new Map([["t", { agents, tasks: [], interactions }]]);
}

/** One chain `size` subagents deep. */
function deep(size: number): Map<string, ThreadWork> {
  const agents = [make("root", null, 0)];
  for (let index = 0; index < size; index++)
    agents.push(make(`a${index}`, index ? `a${index - 1}` : "root", index + 1));
  return new Map([["t", { agents, tasks: [], interactions: [] }]]);
}

function measure(works: Map<string, ThreadWork>): number {
  const forest = agentForest("t", works);
  const group = () => summaryAgents("t", forest, works);
  for (let warm = 0; warm < 5; warm++) group();
  const runs: number[] = [];
  for (let run = 0; run < 21; run++) {
    const start = performance.now();
    group();
    runs.push(performance.now() - start);
  }
  return median(runs);
}

let failed = false;
for (const [name, shape] of [
  ["requests pending", wide],
  ["chain depth", deep],
] as const) {
  const times = sizes.map((size) => measure(shape(size)));
  sizes.forEach((size, index) =>
    process.stdout.write(`${name}: ${size} agents ${(times[index] ?? 0).toFixed(3)} ms\n`),
  );
  // Sixteen times the agents: about 16x when linear, up to 256x when quadratic.
  const growth = (times.at(-1) ?? 0) / Math.max(times[0] ?? 0, 0.01);
  process.stdout.write(`  16x the agents took ${growth.toFixed(1)}x the time\n`);
  if (growth > 32) failed = true;
}
if (failed) {
  process.stdout.write("The Summary's grouping grew faster than linear in the agents.\n");
  process.exitCode = 1;
}
