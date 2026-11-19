import { test, expect } from "vitest";
import { teaChecks } from "./tea-checks.ts";
const head = "a".repeat(40);
const signal = new AbortController().signal;
test.each([
  ["success", ["success"], "success"],
  ["success", ["success", "pending"], "pending"],
  ["success", ["success", "future"], "unknown"],
  ["pending", ["success"], "pending"],
  ["future", ["success"], "unknown"],
  ["failure", ["success"], "failure"],
  ["success", [], "none"],
] as const)("host %s and statuses %j produce %s", async (state, statuses, ci) => {
  const result = await teaChecks(
    async () => ({
      code: 0,
      stdout: JSON.stringify({
        sha: head,
        state,
        total_count: statuses.length,
        statuses: statuses.map((status, i) => ({ id: i + 1, context: `job-${i}`, status })),
      }),
      truncated: false,
      http: { status: 200, headers: {} },
    }),
    "work",
    "repos/team/app",
    head,
    signal,
  );
  expect(result.ci).toBe(ci);
  expect(result.checks.map((c) => c.name)).toEqual(statuses.map((_, i) => `job-${i}`));
});
test("checks include pending work on later pages", async () => {
  const result = await teaChecks(
    async (r) => {
      const page = new URL(`https://git.example/${r.args[1]}`).searchParams.get("page");
      const statuses =
        page === "1"
          ? Array.from({ length: 100 }, (_, i) => ({
              id: i + 1,
              context: `job-${i}`,
              status: "success",
            }))
          : [{ id: 101, context: "remaining", status: "pending" }];
      return {
        code: 0,
        stdout: JSON.stringify({ sha: head, state: "success", total_count: 101, statuses }),
        truncated: false,
        http: { status: 200, headers: {} },
      };
    },
    "work",
    "repos/team/app",
    head,
    signal,
  );
  expect(result.ci).toBe("pending");
  expect(result.checks).toHaveLength(101);
});
test("checks refuse a different commit instead of reporting another head's success", async () => {
  await expect(
    teaChecks(
      async () => ({
        code: 0,
        stdout: JSON.stringify({
          sha: "b".repeat(40),
          state: "success",
          total_count: 0,
          statuses: [],
        }),
        truncated: false,
        http: { status: 200, headers: {} },
      }),
      "work",
      "repos/team/app",
      head,
      signal,
    ),
  ).rejects.toMatchObject({ kind: "head_moved" });
});
