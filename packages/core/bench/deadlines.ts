import { ThreadId } from "@ace/protocol";
import { apply, createThreadState, nextDeadline } from "../src/index.ts";

// Run at merge under the owner's test policy. Setup is outside the measured pass.
for (const workload of ["shell-siblings", "staggered-shell-siblings", "nested-wakes"] as const) {
  for (const count of [20, 40, 80, 160]) {
    let sequence = 0;
    const state = createThreadState({
      threadId: ThreadId.parse("benchmark"),
      config: { provider: "codex", silenceMs: 10 },
    });
    const ids = { next: (kind: string) => `${kind}-${++sequence}` };
    const send = (input: unknown, now = 100) => apply(state, input, { now, ids });
    send({ type: "turn.started", agent: "root", trigger: "user" });
    if (workload === "nested-wakes")
      send({ type: "turn.ended", agent: "root", outcome: "completed" });
    let parent = "root";
    for (let index = 0; index < count; index++) {
      const agent = `child-${index}`;
      const now = workload === "staggered-shell-siblings" ? 100 + index : 100;
      if (workload === "nested-wakes") {
        send({
          type: "agent.seen",
          agent,
          parent,
          origin: "provider_subagent",
          native: { provider: "codex" },
          fidelity: "full",
          cwd: "/repo",
        });
        parent = agent;
      }
      send({ type: "turn.started", agent, trigger: "spawn" }, now);
      if (workload === "nested-wakes") {
        send({ type: "turn.ended", agent, outcome: "completed" });
        send({ type: "wake.expected", agent, until: 200 + index });
      } else {
        send(
          { type: "item.delta", agent, item: `shell-${index}`, field: "output", append: "." },
          now,
        );
      }
    }
    let agentReads = 0;
    let itemReads = 0;
    state.agents = new Proxy(state.agents, {
      get(target, key, receiver) {
        if (typeof key === "string" && Object.hasOwn(target, key)) agentReads++;
        return Reflect.get(target, key, receiver);
      },
    });
    state.items = new Proxy(state.items, {
      get(target, key, receiver) {
        if (typeof key === "string" && Object.hasOwn(target, key)) itemReads++;
        return Reflect.get(target, key, receiver);
      },
    });
    let earliest: number | undefined;
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    for (let pass = 0; pass < 100; pass++) earliest = nextDeadline(state);
    const ms = +(performance.now() - started).toFixed(2);
    const rssAfter = process.memoryUsage().rss;
    console.log(
      JSON.stringify({
        workload,
        children: count,
        passes: 100,
        earliest: earliest ?? null,
        agentReadsPerPass: agentReads / 100,
        itemReadsPerPass: itemReads / 100,
        ms,
        rssBefore,
        rssAfter,
        processPeakRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  }
}
