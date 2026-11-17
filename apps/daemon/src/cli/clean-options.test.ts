import { describe, expect, test } from "vitest";
import { commandTable } from "./commands/table.ts";
import { planOperation } from "./clean-options.ts";
import { parseCommandLine } from "./parse.ts";

/** A command line read the way `ace` reads it, then turned into the daemon's plan request. */
function plan(line: string[], files: Record<string, string> = {}) {
  const parsed = parseCommandLine(commandTable(), line);
  if (parsed.kind !== "command") throw new Error(`not a command: ${JSON.stringify(parsed)}`);
  return planOperation(
    { words: [...parsed.words], flags: { ...parsed.flags }, lists: parsed.lists },
    async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
  );
}

const retention = {
  threads: 90,
  attachments: 30,
  artifacts: 30,
  logs: 14,
  worktrees: 30,
  caches: 7,
};

describe("new and old spellings ask the daemon for the same plan", () => {
  test.each<[string, string[], string[], Record<string, string>?]>([
    [
      "repeated --force-item and the old --force-items JSON",
      ["storage", "plan", "--logs", "--force-item", "a", "--force-item", "b"],
      ["clean", "--dry-run", "--logs", "--force-items", '["a","b"]'],
    ],
    [
      "--retention @FILE and the old inline JSON",
      ["storage", "plan", "--retention", "@keep.json"],
      ["storage", "plan", "--retention", JSON.stringify(retention)],
      { "keep.json": JSON.stringify(retention) },
    ],
    [
      "kind switches and the old --kinds list",
      ["storage", "clean", "--dry-run", "--logs", "--caches"],
      ["clean", "--dry-run", "--kinds", "logs,caches"],
    ],
  ])("%s", async (_name, now, before, files = {}) => {
    expect(await plan(now, files)).toEqual(await plan(before, files));
  });
});

test("--older-than limits the plan to the kinds named, and disables the rest", async () => {
  const operation = await plan(["storage", "plan", "--logs", "--older-than", "30d"]);
  expect(operation).toMatchObject({ op: "cleanup.plan", kinds: ["logs"], forceItems: [] });
  expect(operation.retention).toMatchObject({ logs: 30, threads: null, caches: null });
});

test("no flags plans with the saved retention and forces nothing", async () => {
  expect(await plan(["storage", "plan"])).toEqual({ op: "cleanup.plan", forceItems: [] });
});

describe("contradictory or malformed flags are usage errors that name the flag", () => {
  test.each<[string[], string, string]>([
    [["storage", "plan", "--older-than", "7d"], "--older-than", "needs at least one kind"],
    [["storage", "plan", "--logs", "--older-than", "7"], "--older-than", "whole days"],
    [["storage", "plan", "--logs", "--kinds", "logs"], "--kinds", "not both"],
    [["storage", "plan", "--kinds", "logs,dreams"], "--kinds", "comma-separated"],
    [
      ["storage", "plan", "--logs", "--older-than", "7d", "--retention", "@x.json"],
      "--older-than",
      "not both",
    ],
    [["storage", "plan", "--retention", "@missing.json"], "--retention", "Couldn't read"],
    [["storage", "plan", "--retention", '{"logs": -1}'], "--retention", "days per kind"],
    [["storage", "plan", "--force-items", "not json"], "--force-items", "JSON list"],
    [
      ["storage", "plan", "--force-item", "a", "--force-items", '["b"]'],
      "--force-items",
      "not both",
    ],
  ])("%j", async (line, argument, words) => {
    const failure = plan(line);
    await expect(failure).rejects.toMatchObject({ outcome: "usage", detail: { argument } });
    await expect(failure).rejects.toThrow(words);
  });
});
