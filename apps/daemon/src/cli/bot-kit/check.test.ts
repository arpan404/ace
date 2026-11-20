import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliFailure } from "../output.ts";
import { checkPackage } from "./check.ts";

/** Flight watcher with its one contract, `cheapest_fare`, as `input` and `required` shape it. */
const watcher = (required: string[]) => ({
  format: "spade-bot",
  version: 3,
  requires: { runtime: "1" },
  name: "Flight watcher",
  blurb: "Watches fares for the trips you name.",
  task: "You watch flight fares for the person.",
  contracts: [
    {
      name: "cheapest_fare",
      summary: "The cheapest fare seen for a route this week.",
      input: {
        type: "object",
        properties: {
          from: { type: "string", maxLength: 3 },
          to: { type: "string", maxLength: 3 },
          month: { type: "string", maxLength: 7 },
        },
        required,
      },
      output: {
        type: "object",
        properties: { fare: { type: "number" } },
        required: ["fare"],
      },
    },
  ],
  tests: ["tests/answers.json"],
  pricing: { kind: "free" },
});

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function folder(bot: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bot-check-"));
  folders.push(dir);
  const root = join(dir, "flight-watcher");
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "bot.json"), JSON.stringify(bot, null, 2));
  await writeFile(join(root, "README.md"), "# Flight watcher\n\nWatches fares.\n");
  await writeFile(
    join(root, "tests/answers.json"),
    JSON.stringify({
      name: "Answers",
      given: { call: { contract: "cheapest_fare", input: { from: "KTM", to: "DEL" } } },
      model: [{ say: "Sent." }],
    }),
  );
  return root;
}

describe("ace bot check against the version other bots call", () => {
  it("passes a version that keeps its contracts' callers working", async () => {
    const before = await folder(watcher(["from", "to", "month"]));
    const after = await folder(watcher(["from", "to"]));
    const checked = await checkPackage(after, { against: before });
    expect(checked.name).toBe("flight-watcher");
  });

  it("refuses a change that would break its callers, with each change at its place", async () => {
    const before = await folder(watcher(["from", "to"]));
    const after = await folder(watcher(["from", "to", "month"]));
    const failure = await checkPackage(after, { against: `${before}/bot.json` }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CliFailure);
    expect(String((failure as CliFailure).message)).toContain("would break bots that call it");
    expect(JSON.stringify(failure)).toContain(
      "contracts: cheapest_fare: input.month became required. A change that breaks callers takes a new contract name.",
    );
    // Checked alone, the same folder passes: only callers make it a break.
    await expect(checkPackage(after)).resolves.toMatchObject({ name: "flight-watcher" });
  });
});
