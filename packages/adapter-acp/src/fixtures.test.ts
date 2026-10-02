import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";
import type { Frame } from "./contracts.ts";
import { harness } from "./test-helper.ts";
const directory = fileURLToPath(
  new URL("../../../fixtures/cursor/2026.09.26-dd393fe/", import.meta.url),
);
for (const name of readdirSync(directory).filter((f) => f.endsWith(".jsonl"))) {
  it(`replays ${name} with correct status checkpoints`, () => {
    const h = harness();
    const rows = readFileSync(`${directory}/${name}`, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l) as Frame);
    const expectations = JSON.parse(
      readFileSync(`${directory}/${name.replace(".jsonl", ".expect.json")}`, "utf8"),
    ) as {
      checkpoints: { t: number; thread: string }[];
      final: { thread: string; agents: number; interactions?: Record<string, number> };
    };
    let index = 0;
    for (const checkpoint of expectations.checkpoints) {
      while (rows[index] && rows[index]!.t <= checkpoint.t) h.replay(rows[index++]!);
      h.tick(checkpoint.t);
      expect(h.state.status.state, `${name} at ${checkpoint.t}`).toBe(checkpoint.thread);
    }
    while (rows[index]) h.replay(rows[index++]!);
    expect(h.state.status.state).toBe(expectations.final.thread);
    expect(Object.keys(h.state.agents)).toHaveLength(expectations.final.agents);
    for (const [status, count] of Object.entries(expectations.final.interactions ?? {}))
      expect(Object.values(h.state.interactions).filter((i) => i.state === status)).toHaveLength(
        count,
      );
  });
}
