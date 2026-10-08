// Match coldStartReplay's checkout totals: two files, 38 additions and six deletions.
const retry = [
  "export async function retry(task, attempts = 3) {",
  "  for (let attempt = 1; attempt <= attempts; attempt++) {",
  "    try {",
  "      return await task();",
  "    } catch (error) {",
  "      if (attempt === attempts) throw error;",
  "      await delay(100 * attempt);",
  "    }",
  "  }",
  "}",
  "",
  "function delay(ms) {",
  "  return new Promise((resolve) => setTimeout(resolve, ms));",
  "}",
  "",
  "export function retryable(error) {",
  "  return error instanceof Error",
  '    && !error.message.includes("cancelled");',
  "}",
];
const tests = [
  'import { expect, test } from "vitest";',
  'import { retry } from "./retry";',
  "",
  'test("a temporary failure is retried", async () => {',
  "  let attempts = 0;",
  "  const value = await retry(async () => {",
  "    attempts++;",
  '    if (attempts === 1) throw new Error("offline");',
  '    return "ready";',
  "  });",
  '  expect(value).toBe("ready");',
  "  expect(attempts).toBe(2);",
  "});",
  "",
  'test("the last failure is returned", async () => {',
  '  const failure = new Error("offline");',
  "  await expect(retry(async () => { throw failure; }, 1)).rejects.toBe(failure);",
  "});",
  "",
];
export const uncommittedPatch = [retry, tests]
  .flatMap((lines, index) => {
    const path = index === 0 ? "src/lib/retry.ts" : "src/lib/retry.test.ts";
    return [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,3 +1,${lines.length} @@`,
      "-export const retry = (task) => task();",
      "-// Retry is not configured yet.",
      "-",
    ].concat(lines.map((line) => `+${line}`));
  })
  .concat("")
  .join("\n");
