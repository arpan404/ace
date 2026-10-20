/*
 * Agent action latency: a fixed screen_state / screen_act sequence through the real toolkit
 * and helper, in Calculator (it only types into Calculator and presses its buttons).
 * Operates apps on this Mac: run only on purpose.
 *   ACE_COMPUTER_HELPER=<built helper> node packages/screen/bench/computer-actions.ts [rounds]
 * Prints one JSON report: p50/p95 per step (round 1 is reported apart as the cold run).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { McpScope } from "@ace/protocol";
import { ComputerClient, computerToolkit } from "../src/index.ts";

const helper = process.env["ACE_COMPUTER_HELPER"];
if (!helper) throw new Error("Set ACE_COMPUTER_HELPER");
const rounds = Number(process.argv[2] ?? "8");
const client = new ComputerClient({ helper: async () => helper, nextId: randomUUID });
const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
computerToolkit(client).register(registry);
const credentials = new CredentialRegistry(() => "a".repeat(64));
const lease = credentials.issue(
  McpScope.parse({ sessionId: "bench", threadId: "bench", agentId: "root", capabilities: ["screen"] }),
  new AbortController().signal,
);

const samples = new Map<string, number[]>();
const cold = new Map<string, number>();
async function call(label: string, round: number, name: string, args: Record<string, unknown>) {
  const started = performance.now();
  const result = await registry.call(name, args, lease.principal, new AbortController().signal);
  const ms = performance.now() - started;
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  if (result.isError) throw new Error(`${label}: ${text}`);
  if (round === 0) cold.set(label, ms);
  else samples.set(label, [...(samples.get(label) ?? []), ms]);
  return text;
}
const idOf = (outline: string, pattern: RegExp) => {
  for (const line of outline.split("\n")) {
    const match = pattern.exec(line.trim());
    if (match) return Number(match[1]);
  }
  throw new Error(`No element matching ${pattern}`);
};

try {
  for (let round = 0; round <= rounds; round++) {
    const calc = await call("look", round, "screen_state", { app: "Calculator", full: true });
    const seven = idOf(calc, /^(\d+) button 7$/);
    await call("type expression", round, "screen_act", {
      app: "Calculator",
      actions: [{ type: "key", key: "Escape" }, { type: "type", text: "12+34=" }],
    });
    await call("click by id", round, "screen_act", { app: "Calculator", actions: [{ type: "click", id: seven }] });
    await call("click by id, no observe", round, "screen_act", {
      app: "Calculator",
      actions: [{ type: "click", id: seven }],
      observe: false,
    });
    await call("screenshot only", round, "screen_state", { app: "Calculator", outline: false, screenshot: true });
    await call("look + screenshot", round, "screen_state", { app: "Calculator", screenshot: true });
    await call("repeat look", round, "screen_state", { app: "Calculator" });
    await call("act + screenshot", round, "screen_act", {
      app: "Calculator",
      actions: [{ type: "key", key: "Escape" }],
      screenshot: true,
    });
  }
} finally {
  client.close();
  credentials.close();
}

const percentile = (values: number[], p: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0);
};
const steps = Object.fromEntries(
  [...samples].map(([label, values]) => [
    label,
    { coldMs: Math.round(cold.get(label) ?? 0), p50Ms: percentile(values, 50), p95Ms: percentile(values, 95) },
  ]),
);
const total = [...samples.values()].reduce((sum, values) => sum + percentile(values, 50), 0);
console.log(JSON.stringify({ rounds, load: execFileSync("sysctl", ["-n", "vm.loadavg"]).toString().trim(), sequenceP50Ms: total, steps }, null, 2));
