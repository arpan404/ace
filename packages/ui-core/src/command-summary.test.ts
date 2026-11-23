import { expect, test } from "vitest";
import { commandLabel } from "./command-summary.ts";
import { leftRunningStripLine } from "./mobile-strips.ts";
import { waitWords } from "./wait-words.ts";

test.each([
  [
    'export CARGO_TARGET_DIR="/tmp/my target"; cd packages/ui-core && bunx vitest run apps/ios/bridge',
    "bunx vitest run apps/ios/bridge",
  ],
  [
    "bash -lc 'cd ace && env CI=1 nice -n 19 ~/.local/bin/heavy bun run check:size'",
    "bun run check:size",
  ],
  [
    "{\nexport MODE=test\nNODE_OPTIONS='--max-old-space-size=4096' bun run typecheck;\n}",
    "bun run typecheck",
  ],
  ['env MESSAGE="one; two && three" node server.js', "node server.js"],
  [
    "export DIR=$(git rev-parse --show-toplevel); cargo test --all-targets",
    "cargo test --all-targets",
  ],
  ['printf "%s" "first; second" | tee result.txt', 'printf "%s" "first; second"'],
  ["cd packages/ui-core", "cd packages/ui-core"],
  ["bun run dev", "bun run dev"],
])("shows the meaningful command from %s", (command, summary) => {
  expect(leftRunningStripLine({ over: true, subagents: 0, commands: [command] })?.payload).toBe(
    summary,
  );
  expect(
    waitWords({ kind: "background", count: 1, title: command, shells: true, taskIds: [] }).code,
  ).toBe(summary);
});

test.each([
  [
    "a Claude Bash call names itself by its description",
    { command: "sleep 20; cat /private/tmp/claude-501/x/out", description: "Wait for build,\n then install " },
    "Wait for build, then install",
  ],
  ["a Codex command has no description and reads as its summary", { command: "cd ace && bun run check:size" }, "bun run check:size"],
  ["a blank description falls back to the summary", { command: "bun run lint", description: "  " }, "bun run lint"],
])("%s", (_name, input, label) => {
  expect(commandLabel(input)).toBe(label);
});
