/*
 * Daemon-side cost of `sim_*` calls through the real devices service and toolkit over the fake
 * platform (`testing/fake-sim.ts`). Drives no simulator or device. Run with a phase's switch
 * off and on (ADR 0225): `bun packages/devices/bench/sim-tools.ts [calls]`. Non-gating.
 */
import { performance } from "node:perf_hooks";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { AgentId, ThreadId } from "@ace/protocol";
import { devicesToolkit } from "../src/index.ts";
import { fakeNode, fakeSimService } from "../src/testing/fake-sim.ts";

const calls = Number(process.argv[2] ?? 300);
const ios = "ios:00000000-0000-4000-8000-00000000F00D";
const fake = await fakeSimService();
const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
devicesToolkit(fake.service).register(registry);
const credentials = new CredentialRegistry(() => "c".repeat(64));
const lease = credentials.issue(
  {
    sessionId: "measure",
    threadId: ThreadId.parse("thread-1"),
    agentId: AgentId.parse("agent-1"),
    capabilities: ["devices"],
  },
  new AbortController().signal,
);
fake.platform.screens.set(
  ios,
  Array.from({ length: 120 }, (_, i) =>
    fakeNode(
      `n${i}`,
      i % 3 ? "StaticText" : "Button",
      `Item ${i}`,
      { x: 0, y: i * 20, w: 300, h: 20 },
      i % 3 ? [] : ["press"],
    ),
  ),
);
const call = (name: string, args: Record<string, unknown>) =>
  registry.call(name, args, lease.principal, new AbortController().signal);
const percentile = (values: number[], p: number) =>
  values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0;
try {
  await call("sim_start", { simId: ios });
  const cases: [string, Record<string, unknown>][] = [
    ["sim_list", {}],
    ["sim_ui", { simId: ios }],
    ["sim_act", { simId: ios, action: "tap", ref: "@e1" }],
    ["sim_act", { simId: ios, action: "tap", x: 10, y: 10 }],
    ["sim_screenshot", { simId: ios }],
  ];
  for (const [name, args] of cases) {
    await call(name, args);
    const times: number[] = [];
    const cpu = process.cpuUsage();
    for (let i = 0; i < calls; i++) {
      const start = performance.now();
      await call(name, args);
      times.push(performance.now() - start);
    }
    const used = process.cpuUsage(cpu);
    process.stdout.write(
      `${JSON.stringify({
        name,
        args,
        calls,
        p50Ms: Number(percentile(times, 0.5).toFixed(3)),
        p95Ms: Number(percentile(times, 0.95).toFixed(3)),
        cpuUsPerCall: Math.round((used.user + used.system) / calls),
      })}\n`,
    );
  }
} finally {
  credentials.close();
  await fake.close();
}
