import type { ToolStatus, TurnDigest } from "@ace/protocol";
import { displayCommand } from "./step-display.ts";

/*
 * Which commands are checks (tests, typechecks, linters, builds), so the Summary can say how the
 * latest of each went. A command it doesn't recognise is not a check. Pure.
 */

export type CheckKind = "test" | "typecheck" | "lint" | "build" | "check";

export const checkLabels: Record<CheckKind, string> = {
  test: "Tests",
  typecheck: "Typecheck",
  lint: "Lint",
  build: "Build",
  check: "Checks",
};

/** A package script's name ("test:unit", "type-check") as the check it runs. */
function scriptKind(script: string): CheckKind | undefined {
  const head = script.toLowerCase().split(/[:.]/)[0] ?? "";
  if (/^(test|tests|e2e|spec|unit)$/.test(head)) return "test";
  if (/^(typecheck|type-check|types|tsc)$/.test(head)) return "typecheck";
  if (/^(lint|eslint|oxlint)$/.test(head)) return "lint";
  if (/^(fmt|format)$/.test(head)) return /check/.test(script) ? "lint" : undefined;
  if (/^(build|compile)$/.test(head)) return "build";
  if (/^(check|ci|verify|validate)$/.test(head)) return "check";
  return undefined;
}

/** `tool sub` pairs that are checks: `cargo test`, `go vet`, `swift build`. */
const subcommands: Record<string, Record<string, CheckKind>> = {
  cargo: { test: "test", nextest: "test", check: "typecheck", clippy: "lint", build: "build" },
  go: { test: "test", vet: "lint", build: "build" },
  swift: { test: "test", build: "build" },
  dotnet: { test: "test", build: "build" },
  deno: { test: "test", lint: "lint", check: "typecheck" },
  mvn: { test: "test", verify: "check", package: "build" },
  gradle: { test: "test", check: "check", build: "build" },
  "./gradlew": { test: "test", check: "check", build: "build" },
  make: { test: "test", check: "check", lint: "lint", build: "build" },
  biome: { check: "lint", lint: "lint", ci: "lint" },
  ruff: { check: "lint" },
  playwright: { test: "test" },
  xcodebuild: { test: "test", build: "build" },
};

/** Tools that are a check on their own, whatever follows. */
const tools: Record<string, CheckKind> = {
  vitest: "test",
  jest: "test",
  mocha: "test",
  pytest: "test",
  rspec: "test",
  phpunit: "test",
  tsc: "typecheck",
  "vue-tsc": "typecheck",
  mypy: "typecheck",
  pyright: "typecheck",
  eslint: "lint",
  oxlint: "lint",
  flake8: "lint",
  pylint: "lint",
  rubocop: "lint",
  golangci: "lint",
  "golangci-lint": "lint",
};

const managers = new Set(["bun", "npm", "pnpm", "yarn"]);
/** Runners that start the tool named after them: `bunx vitest`, `npx tsc`, `pnpm exec eslint`. */
const launchers = new Set(["npx", "bunx", "pnpx", "uvx", "poetry", "uv", "pipenv"]);

/** One simple command's words, without leading env assignments, launchers and paths. */
function words(segment: string): string[] {
  const parts = segment.trim().split(/\s+/).filter(Boolean);
  while (parts.length && /^\w+=/.test(parts[0] ?? "")) parts.shift();
  while (parts.length > 1) {
    const first = parts[0] ?? "";
    const second = parts[1] ?? "";
    if (launchers.has(first) || first === "run") parts.shift();
    else if (managers.has(first) && (second === "exec" || second === "dlx" || second === "x"))
      parts.splice(0, 2);
    else if (/^python[\d.]*$/.test(first) && second === "-m") parts.splice(0, 2);
    else break;
  }
  return parts.map((part, index) =>
    index === 0 && part !== "./gradlew" ? (part.split("/").at(-1) ?? part) : part,
  );
}

function segmentKind(segment: string): CheckKind | undefined {
  const [first, second, third] = words(segment);
  if (!first) return undefined;
  if (managers.has(first)) {
    if (!second) return undefined;
    // `bun test` is bun's own runner; `npm test`, `yarn lint`, `bun run typecheck` are scripts.
    if (second === "run" || second === "run-script") return third ? scriptKind(third) : undefined;
    if (second.startsWith("-")) return undefined;
    return scriptKind(second);
  }
  const tool = tools[first];
  if (tool) return tool;
  const sub = subcommands[first];
  return sub && second ? sub[second] : undefined;
}

/**
 * The check a shell command runs: "bun run typecheck" is a typecheck, "cargo test" a test run,
 * "cd app && npx eslint ." a lint. A chain counts as its last recognised command; anything else
 * (installs, git, reads) is not a check.
 */
export function checkKind(command: string): CheckKind | undefined {
  const shown = displayCommand({ command }).command;
  let kind: CheckKind | undefined;
  for (const segment of shown.split(/&&|\|\||;|\|/)) kind = segmentKind(segment) ?? kind;
  return kind;
}

export interface CheckRun {
  kind: CheckKind;
  itemId: string;
  /** The command as the person would have typed it. */
  command: string;
  failed: boolean;
  exitCode: number | null | undefined;
}

/**
 * The latest run of each kind of check among a turn's commands (the digest lists them oldest
 * first), in the order they last ran. A later passing run replaces an earlier failure.
 */
export function latestChecks(commands: TurnDigest["commands"]): CheckRun[] {
  const latest = new Map<CheckKind, CheckRun>();
  for (const command of commands) {
    const kind = checkKind(command.command);
    if (!kind) continue;
    latest.delete(kind);
    latest.set(kind, {
      kind,
      itemId: command.itemId,
      command: displayCommand({ command: command.command }).command,
      failed: command.failed,
      exitCode: command.exitCode,
    });
  }
  return [...latest.values()];
}

export type CheckOutcome = "passed" | "failed" | "running" | "ran";

/**
 * How a check went: failed or passed by its exit, still running while its step runs, and only
 * "ran" when neither its exit nor its step says (a provider that reports no exit code).
 */
export function checkOutcome(run: CheckRun, step?: ToolStatus | undefined): CheckOutcome {
  if (run.failed || step === "failed") return "failed";
  if (run.exitCode === 0) return "passed";
  if (step === "running" || step === "pending" || step === "awaiting_approval") return "running";
  if (step === "succeeded") return "passed";
  return "ran";
}
