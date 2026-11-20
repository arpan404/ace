import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CliProblem } from "@ace/protocol/cli-output";
import { CliBotTest } from "@ace/protocol/cli-outputs";
import { z } from "zod";
import { CliFailure } from "../output.ts";

/*
 * `ace bot test [PATH]` (ADR 0200 §9): the package's scenarios on Spade's real engine, run by
 * Spade's own program (`spade --bot-test`) on a throwaway home with spade-testkit's scripted
 * model. The CLI only finds the program, gives it a bare environment and reads its report: no
 * keys, no proxies, nothing of the person's reaches it.
 */

/** How long one package's scenarios may take. */
const TIME_MS = 10 * 60_000;

/** What `spade --bot-test` prints, before `passed` is worked out. */
const Report = CliBotTest.omit({ passed: true });

/**
 * Spade's program: `ACE_SPADE_BIN`, else the one this release carries, else (running ace from
 * source) the checkout's own debug build. Undefined when there is none.
 */
export async function spadeProgram(
  env: Readonly<Record<string, string | undefined>>,
  entry: string | undefined,
): Promise<string | undefined> {
  const { bundledSpadeBinary } = await import("../../spade/service-control.ts");
  try {
    const bundled = bundledSpadeBinary(env, entry, process.platform, existsSync);
    if (env.ACE_SPADE_BIN?.trim() || existsSync(bundled)) return bundled;
  } catch {
    // Running from source with no ACE_SPADE_BIN: try the checkout's build below.
  }
  const program = process.platform === "win32" ? "spade.exe" : "spade";
  const checkout = resolve(import.meta.dirname, "../../../../../spade/target/debug", program);
  return existsSync(checkout) ? checkout : undefined;
}

/** A report's failures as problems at their places. Pure. */
export function testProblems(report: CliBotTest): CliProblem[] {
  return [
    ...report.problems.map((problem) => {
      const at = /^([^:]+\.json): (.*)$/s.exec(problem);
      return at?.[1] && at[2] ? { path: at[1], message: at[2] } : { message: problem };
    }),
    ...report.scenarios.flatMap((scenario) =>
      scenario.failures.map((failure) => ({
        path: scenario.file,
        message: `${scenario.name}: ${failure}`,
      })),
    ),
  ];
}

/** `ace bot test`'s lines for a run that passed. Pure. */
export function testLines(report: CliBotTest): string[] {
  const count = report.scenarios.length;
  return [
    ...report.scenarios.map((scenario) => `✓ ${scenario.file}: ${scenario.name}`),
    `${report.name ?? "The package"} passes ${count} scenario${count === 1 ? "" : "s"}, offline on a scripted model.`,
  ];
}

/** Runs `folder`'s scenarios with `program`; the report, or a failure carrying its problems. */
export async function testPackage(folder: string, program: string): Promise<CliBotTest> {
  const home = await mkdtemp(join(tmpdir(), "ace-bot-test-"));
  try {
    const { stdout, code } = await new Promise<{ stdout: string; code: number }>((done) => {
      execFile(
        program,
        ["--bot-test", resolve(folder)],
        {
          // A bare environment: the run reads no key, proxy or setting of the person's.
          env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: home },
          timeout: TIME_MS,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, printed) => {
          const exit = error && typeof error.code === "number" ? error.code : error ? -1 : 0;
          done({ stdout: printed, code: exit });
        },
      );
    });
    let parsed: z.infer<typeof Report>;
    try {
      parsed = Report.parse(JSON.parse(stdout));
    } catch {
      throw new CliFailure(
        "failed",
        code === 2 || code === -1
          ? `Spade's program couldn't run the tests (${program}).`
          : "Spade's program answered without a report.",
        undefined,
        { code: "failed", hint: "Check that ACE_SPADE_BIN names a spade from this ace's release." },
      );
    }
    const report: CliBotTest = {
      ...parsed,
      passed: parsed.problems.length === 0 && parsed.scenarios.every((s) => s.passed),
    };
    if (report.passed) return report;
    const problems = testProblems(report);
    const failed = report.scenarios.filter((scenario) => !scenario.passed).length;
    throw new CliFailure(
      "failed",
      failed
        ? `${failed} of ${report.scenarios.length} scenario${report.scenarios.length === 1 ? "" : "s"} failed.`
        : `${report.name ?? "The package"} has ${problems.length} problem${problems.length === 1 ? "" : "s"} to fix before its tests run.`,
      report,
      { code: "check_failed", problems },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
