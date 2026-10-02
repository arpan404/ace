import { readdirSync } from "node:fs";
import { fixture, harness } from "./replay.ts";
for (const name of readdirSync("fixtures/opencode/1.18.33").filter((n) => n.endsWith(".jsonl"))) {
  const h = harness();
  const timeline: unknown[] = [];
  let prior = "";
  for (const f of fixture(`fixtures/opencode/1.18.33/${name}`)) {
    h.feed(f);
    const current = JSON.stringify(h.state.status);
    if (prior !== current) {
      timeline.push({ t: f.t, seq: f.seq, status: h.state.status });
      prior = current;
    }
  }
  console.log(name, JSON.stringify(timeline));
  console.log(
    "final",
    Object.values(h.state.agents).length,
    Object.values(h.state.interactions).map((i) => ({
      kind: i.request.kind,
      state: i.state,
      resolution: i.resolution,
    })),
    h.events
      .filter(
        (e) => e.type === "item.created" && e.item.type === "notice" && e.item.level === "warning",
      )
      .slice(0, 3),
  );
}
