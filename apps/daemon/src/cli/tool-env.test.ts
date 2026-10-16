import { afterEach, expect, test } from "vitest";
import type { Client } from "@ace/client";
import { readToolEnvEntries, toolEnvCommand } from "./tool-env.ts";
import { CliFailure } from "./output.ts";

const exitCode = process.exitCode;
afterEach(() => {
  process.exitCode = exitCode;
});

test("entries come from the CLI environment, never argv", () => {
  expect(
    readToolEnvEntries(["GH_TOKEN", "GH_HOST"], { GH_TOKEN: "gho_x", GH_HOST: "ghe.example.com" }),
  ).toEqual([
    { key: "GH_TOKEN", value: "gho_x" },
    { key: "GH_HOST", value: "ghe.example.com" },
  ]);
});

test("unknown names, missing values and counts are refused", () => {
  expect(() => readToolEnvEntries(["OPENAI_API_KEY"], { OPENAI_API_KEY: "x" })).toThrow(CliFailure);
  expect(() => readToolEnvEntries(["GH_TOKEN"], {})).toThrow(CliFailure);
  expect(() => readToolEnvEntries([], {})).toThrow(CliFailure);
  expect(() =>
    readToolEnvEntries(["GH_TOKEN", "GH_TOKEN", "GH_TOKEN", "GH_TOKEN", "GH_TOKEN"], {}),
  ).toThrow(CliFailure);
});

test("submit sends one secret message and blanks its local copies", async () => {
  const seen: unknown[] = [];
  const client = {
    request: async (input: unknown) => {
      seen.push(input);
      return {
        type: "provider.toolEnv.result",
        requestId: "r",
        result: { ok: true, stored: 1 },
      };
    },
  } as unknown as Client;
  const logged: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, callback?: (error?: Error) => void) => {
    logged.push(String(chunk));
    if (callback) callback();
    return true;
  }) as typeof process.stdout.write;
  try {
    await toolEnvCommand(
      { words: ["tool-env", "submit", "thread-1", "GH_TOKEN"], flags: {} },
      client,
      new AbortController().signal,
      { GH_TOKEN: "gho_x" },
    );
  } finally {
    process.stdout.write = write;
  }
  expect(seen).toHaveLength(1);
  const sent = seen[0] as {
    type: string;
    threadId: string;
    entries: Array<{ key: string; value: string }>;
  };
  expect(sent.type).toBe("provider.toolEnv.submit");
  expect(sent.threadId).toBe("thread-1");
  expect(sent.entries).toEqual([{ key: "GH_TOKEN", value: "gho_x" }]);
  expect(logged.join("")).not.toContain("gho_x");
});
