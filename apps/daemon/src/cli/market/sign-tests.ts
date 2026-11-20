import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BotTestRunner } from "@ace/marketplace/signer";
import { CliBotTest } from "@ace/protocol/cli-outputs";
import { spadeProgram, testPackage } from "../bot-kit/test.ts";
import { CliFailure } from "../output.ts";

/*
 * What the maintainer's signer runs a bot package's tests with (ADR 0200 §8): the very scenarios
 * `ace bot test` runs, on Spade's own program (`spade --bot-test`) with its scripted model, from
 * the bytes the market stored, written to a throwaway folder. Offline, and never a real model.
 */

/** The runner for this machine's Spade program; undefined when there is none. */
export async function signerTestRunner(
  env: Readonly<Record<string, string | undefined>>,
  entry: string | undefined,
): Promise<BotTestRunner | undefined> {
  const program = await spadeProgram(env, entry);
  if (!program) return undefined;
  return async (files) => {
    const folder = await mkdtemp(join(tmpdir(), "ace-sign-tests-"));
    try {
      for (const file of files) {
        // The signer checked the archive first: its paths are relative and stay inside.
        const path = join(folder, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content, { mode: file.executable ? 0o700 : 0o600 });
      }
      const report = await testPackage(folder, program).catch((error: unknown) => {
        if (error instanceof CliFailure && error.detail.code === "check_failed") return error;
        throw error;
      });
      if (!(report instanceof CliFailure))
        return { passed: true, scenarios: report.scenarios.length, failures: [] };
      const ran = CliBotTest.safeParse(report.evidence);
      return {
        passed: false,
        scenarios: ran.success ? ran.data.scenarios.length : 0,
        failures: (report.detail.problems ?? []).map((problem) => ({
          path: problem.path,
          message: problem.message,
        })),
      };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };
}
