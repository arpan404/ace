import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixture, harness } from "./replay.ts";
const directory = fileURLToPath(new URL("../../../fixtures/opencode/1.18.33/", import.meta.url));
type Expected = {
  checkpoints: { t: number; thread: string }[];
  final: { thread: string; agents: number; interactions?: Record<string, number> };
};
describe("recorded OpenCode sessions", () => {
  for (const name of readdirSync(directory).filter((n) => n.endsWith(".jsonl"))) {
    it(`${name} preserves its status timeline and final tree`, () => {
      const expected = JSON.parse(
        readFileSync(`${directory}${name.replace(".jsonl", ".expect.json")}`, "utf8"),
      ) as Expected;
      const h = harness();
      const frames = fixture(`${directory}${name}`);
      let at = 0;
      for (const checkpoint of expected.checkpoints) {
        while (at < frames.length && frames[at]!.t <= checkpoint.t) h.feed(frames[at++]!);
        expect(h.state.status.state, `t=${checkpoint.t}`).toBe(checkpoint.thread);
      }
      while (at < frames.length) h.feed(frames[at++]!);
      expect(h.state.status.state).toBe(expected.final.thread);
      expect(Object.values(h.state.agents)).toHaveLength(expected.final.agents);
      for (const [status, count] of Object.entries(expected.final.interactions ?? {}))
        expect(Object.values(h.state.interactions).filter((i) => i.state === status)).toHaveLength(
          count,
        );
      expect(
        h.events.filter(
          (e) =>
            e.type === "item.created" && e.item.type === "notice" && e.item.level === "warning",
        ),
      ).toEqual([]);
    });
  }
});
