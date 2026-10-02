import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Run sequentially in this worktree, with no other tests or edits in flight.
// Each mutant changes production behaviour, runs its guarding real-PTY test,
// and restores the original source even when the runner fails.
const root = resolve(import.meta.dirname, "../../..");
const directory = mkdtempSync(join(root, ".terminal-mutations-"));
const mutations = [
  {
    name: "swap resize axes",
    file: "terminal.ts",
    before: "this.#backend.resize(cols, rows)",
    after: "this.#backend.resize(rows, cols)",
    test: "stty size reports",
  },
  {
    name: "drop environment overrides",
    file: "pty.ts",
    before: "...options.env,",
    after: "",
    test: "environment overrides reach",
  },
  {
    name: "force exit code zero",
    file: "decode.ts",
    before: "code: event.exitCode",
    after: "code: 0",
    test: "late attachers receive final output",
  },
  {
    name: "endOffset plus one",
    file: "attachment.ts",
    before: "endOffset: end,",
    after: "endOffset: end + 1,",
    test: "two concurrent attachers receive",
  },
  {
    name: "remove initial truncation",
    file: "attachment.ts",
    before: "let truncated = cursor !== fromOffset",
    after: "let truncated = false",
    test: "an old offset replays",
  },
  {
    name: "emit partial UTF-8",
    file: "ring.ts",
    before: "return limit - lead < width ? lead : limit",
    after: "return limit",
    test: "a UTF-8 character split across",
  },
  {
    name: "remove start alignment",
    file: "ring.ts",
    before: "if (width > 1 && lead + width > offset)",
    after: "if (false)",
    test: "offsets inside a UTF-8 character",
  },
  {
    name: "disable resync",
    file: "attachment.ts",
    before: "if (cursor < ring.start)",
    after: "if (false)",
    test: "20 MiB drains",
  },
  {
    name: "repeat truncation",
    file: "attachment.ts",
    before: "truncated = false;",
    after: "truncated = true;",
    test: "an old offset replays",
  },
  {
    name: "omit background groups",
    file: "pty.ts",
    before: "return rows.map((row) => ({",
    after: "return rows.filter((row) => row.pid === pty.pid).map((row) => ({",
    test: "closeAll kills a background child",
  },
  {
    name: "retain output strings",
    file: "ring.ts",
    before: "append(bytes: Buffer): void {",
    after:
      'append(bytes: Buffer): void { Object.defineProperty(this, "retained", { value: [...((Reflect.get(this, "retained") as string[] | undefined) ?? []), bytes.toString("utf8")], configurable: true });',
    test: "20 MiB has bounded peak live",
  },
  {
    name: "wrong native terminal type",
    file: "pty.ts",
    before: 'name: "xterm-256color"',
    after: 'name: "wrong"',
    test: "environment overrides reach",
  },
  {
    name: "wrong COLORTERM",
    file: "pty.ts",
    before: 'COLORTERM: "truecolor"',
    after: 'COLORTERM: "wrong"',
    test: "environment overrides reach",
  },
  {
    name: "leave detached read pending",
    file: "attachment.ts",
    before: "pending?.(endResult);",
    after: "",
    test: "detaching resolves a pending read",
  },
  {
    name: "ignore kill signal",
    file: "pty.ts",
    before: "await ownership.kill(signal)",
    after: 'await ownership.kill("SIGTERM")',
    test: "kill retains the POSIX signal",
  },
  {
    name: "empty snapshot scrollback",
    file: "terminal.ts",
    before: 'data: this.#ring.read(this.#ring.start).toString("base64")',
    after: 'data: ""',
    test: "an old offset replays",
  },
  {
    name: "strip ctrl-C",
    file: "terminal.ts",
    before: "this.#backend.write(data)",
    after: 'this.#backend.write(data.replaceAll("\\x03", ""))',
    test: "ctrl-C interrupts",
  },
  {
    name: "stale resize metadata",
    file: "terminal.ts",
    before: "this.#options.cols = cols;",
    after: "this.#options.cols = 80;",
    test: "stty size reports",
  },
  {
    name: "default capacity one MiB",
    file: "manager.ts",
    before: "scrollbackBytes = 4 * 1024 * 1024",
    after: "scrollbackBytes = 1024 * 1024",
    test: "default retention preserves four MiB",
  },
  {
    name: "ignore grace period",
    file: "ownership.ts",
    before: "await scheduler.delay(graceMs)",
    after: "await scheduler.delay(0)",
    test: "SIGKILL waits for the configured grace",
  },
  {
    name: "permit post-exit writes",
    file: "terminal.ts",
    before: 'if (this.#exit) throw new Error("Terminal has exited");',
    after: "",
    test: "writes and resize reject after exit",
  },
  {
    name: "ignore SHELL selection",
    file: "pty.ts",
    before: "if (process.env.SHELL) return process.env.SHELL;",
    after: "",
    test: "the user's SHELL is launched",
  },
  {
    name: "reverse fallback priority",
    file: "pty.ts",
    before: '["/bin/zsh", "/bin/bash"]',
    after: '["/bin/bash", "/bin/zsh"]',
    test: "without SHELL the first installed fallback",
  },
  {
    name: "remove login flag",
    file: "pty.ts",
    before: '["-l", "-i"]',
    after: '["-i"]',
    test: "the user's SHELL is launched",
  },
];

const results: Array<{ mutation: string; test: string; failures: string[] }> = [];
try {
  for (const mutation of mutations) {
    const path = join(root, "packages/terminal/src", mutation.file);
    const original = readFileSync(path, "utf8");
    if (!original.includes(mutation.before))
      throw new Error(`Mutation no longer applies: ${mutation.name}`);
    const report = join(directory, "report.json");
    let failures: string[];
    try {
      writeFileSync(path, original.replace(mutation.before, mutation.after));
      const run = spawnSync(
        "bun",
        [
          "run",
          "test",
          "packages/terminal/src",
          "-t",
          mutation.test,
          "--reporter=json",
          `--outputFile=${report}`,
        ],
        { cwd: root, encoding: "utf8" },
      );
      if (run.error) throw run.error;
      if (run.signal || run.status === 137)
        throw new Error("Runner was killed; rerun the mutation audit");
      const output: unknown = JSON.parse(readFileSync(report, "utf8"));
      if (
        typeof output !== "object" ||
        output === null ||
        !("testResults" in output) ||
        !Array.isArray(output.testResults)
      )
        throw new Error("Invalid Vitest report");
      failures = output.testResults.flatMap((result: unknown) => {
        if (
          typeof result !== "object" ||
          result === null ||
          !("assertionResults" in result) ||
          !Array.isArray(result.assertionResults)
        )
          return [];
        return result.assertionResults.flatMap((assertion: unknown) => {
          if (
            typeof assertion !== "object" ||
            assertion === null ||
            !("status" in assertion) ||
            assertion.status !== "failed" ||
            !("fullName" in assertion) ||
            typeof assertion.fullName !== "string"
          )
            return [];
          return [assertion.fullName];
        });
      });
      if (run.status === 0 || !failures.some((name) => name.includes(mutation.test))) {
        throw new Error(
          `Mutation survived or did not fail its guarding test: ${mutation.name}\n${run.stdout}\n${run.stderr}`,
        );
      }
    } finally {
      writeFileSync(path, original);
    }
    results.push({ mutation: mutation.name, test: mutation.test, failures });
    console.log(`Killed: ${mutation.name} -> ${failures.join(", ")}`);
  }
  console.log(`${results.length}/${mutations.length} mutations killed; all source files restored.`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
