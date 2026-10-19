import { TurnDigest } from "@ace/protocol";
import { expect, test } from "vitest";
import { checkKind, checkOutcome, latestChecks } from "./check-runs.ts";

const commands = (list: unknown[]) => TurnDigest.shape.commands.parse(list);

test("a check without an exit code reads from its step: running while it runs, else ran", () => {
  const [run] = latestChecks(commands([{ itemId: "1", command: "bun run test", failed: false }]));
  if (!run) throw new Error("Expected a check");
  expect(checkOutcome(run, "running")).toBe("running");
  expect(checkOutcome(run, "succeeded")).toBe("passed");
  expect(checkOutcome(run)).toBe("ran");
  expect(checkOutcome({ ...run, failed: true }, "succeeded")).toBe("failed");
});

test.each([
  ["bun run test", "test"],
  ["npm test", "test"],
  ["yarn test:unit --watch=false", "test"],
  ["bun test", "test"],
  ["bunx vitest run src/a.test.ts", "test"],
  ["npx jest", "test"],
  ["python -m pytest -q", "test"],
  ["uv run pytest", "test"],
  ["cargo test --all", "test"],
  ["go test ./...", "test"],
  ["bun run typecheck", "typecheck"],
  ["pnpm type-check", "typecheck"],
  ["npx tsc --noEmit", "typecheck"],
  ["cargo check", "typecheck"],
  ["bun run lint", "lint"],
  ["npx eslint .", "lint"],
  ["oxlint src", "lint"],
  ["cargo clippy", "lint"],
  ["bun run fmt:check", "lint"],
  ["npm run build", "build"],
  ["cargo build --release", "build"],
  ["bun run check", "check"],
  ["cd apps/web && ACE_TEST_WORKERS=4 bun run test", "test"],
  ["/bin/zsh -lc 'bun run typecheck'", "typecheck"],
  ["./node_modules/.bin/vitest run", "test"],
] as const)("%s is a %s check", (command, kind) => {
  expect(checkKind(command)).toBe(kind);
});

test.each([
  "bun install",
  "npm run dev",
  "git commit -m 'run the tests'",
  "ls -la",
  "cat package.json",
  "bun run fmt",
  "pnpm -r exec echo hi",
])("%s is not a check", (command) => {
  expect(checkKind(command)).toBeUndefined();
});

test("each kind keeps only its latest run, so a fix after a failure reads as passing", () => {
  const checks = latestChecks(
    commands([
      { itemId: "1", command: "bun run typecheck", failed: true, exitCode: 2 },
      { itemId: "2", command: "bun install", failed: false, exitCode: 0 },
      { itemId: "3", command: "bun run lint", failed: true, exitCode: 1 },
      { itemId: "4", command: "bun run typecheck", failed: false, exitCode: 0 },
    ]),
  );
  expect(checks.map((check) => [check.kind, check.itemId, check.failed])).toEqual([
    ["lint", "3", true],
    ["typecheck", "4", false],
  ]);
});

test("a check's command reads as typed, without its login-shell wrapper", () => {
  const [check] = latestChecks(
    commands([{ itemId: "1", command: "/bin/zsh -lc 'bun run test'", failed: false, exitCode: 0 }]),
  );
  expect(check?.command).toBe("bun run test");
});
