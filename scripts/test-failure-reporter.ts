import type { Reporter, TestCase } from "vitest/node";

/** Emit failures when they finish, before the full suite's final summary. */
export class FailureDetailsReporter implements Reporter {
  onTestCaseResult(test: TestCase): void {
    const result = test.result();
    if (result.state !== "failed") return;
    process.stderr.write(
      `${JSON.stringify({
        failure: test.fullName,
        project: test.project.name,
        file: test.module.relativeModuleId,
        errors: result.errors.slice(0, 4).map((error) => ({
          name: error.name,
          message: error.message?.slice(0, 8_000),
          stack: error.stack?.slice(0, 8_000),
          diff: error.diff?.slice(0, 8_000),
        })),
      })}\n`,
    );
  }
}
