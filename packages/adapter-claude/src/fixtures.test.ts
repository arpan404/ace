import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { Frame } from "./contract.ts";
import { replay } from "./replay.test-helper.ts";
const directory = fileURLToPath(new URL("../../../fixtures/claude/2.1.286/", import.meta.url));
for (const file of readdirSync(directory).filter((name) => name.endsWith(".jsonl"))) {
  test(`${file} preserves the recorded status timeline`, () => {
    const frames = readFileSync(`${directory}/${file}`, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line) as Frame);
    const result = replay(frames);
    const expected = JSON.parse(
      readFileSync(`${directory}/${file.replace(".jsonl", ".expect.json")}`, "utf8"),
    ) as {
      checkpoints: { t: number; thread: string }[];
      final: { thread: string; agents: number; interactions?: Record<string, number> };
    };
    expect(
      result.events.filter(
        (event) =>
          event.type === "item.created" &&
          event.item.type === "notice" &&
          event.item.raw.some((raw) => raw.type === "core.rejected_fact"),
      ),
    ).toEqual([]);
    for (const checkpoint of expected.checkpoints)
      expect(
        result.timeline.filter((entry) => entry.t <= checkpoint.t).at(-1)?.thread,
        `at ${checkpoint.t}`,
      ).toBe(checkpoint.thread);
    expect(result.state.status.state).toBe(expected.final.thread);
    expect(Object.keys(result.state.agents)).toHaveLength(expected.final.agents);
    for (const [status, count] of Object.entries(expected.final.interactions ?? {}))
      expect(
        Object.values(result.state.interactions).filter(
          (interaction) => interaction.state === status,
        ),
      ).toHaveLength(count);
  });
}
