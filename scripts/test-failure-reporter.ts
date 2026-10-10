import type { Reporter, TestCase } from "vitest/node";

const textLimit = 8_000;
const nodeLimit = 20;
function failureDetails(
  value: unknown,
  seen: Set<object>,
  budget: { nodes: number },
  depth = 0,
): object {
  if (budget.nodes++ >= nodeLimit) return { truncated: "capacity" };
  if (depth >= 5) return { truncated: "depth" };
  if (typeof value !== "object" || value === null)
    return { message: String(value).slice(0, textLimit) };
  if (seen.has(value)) return { truncated: "cycle" };
  seen.add(value);
  const read = (key: string): unknown => {
    try {
      return Reflect.get(value, key);
    } catch {
      return undefined;
    }
  };
  const text = (key: string) => {
    const field = read(key);
    return typeof field === "string" ? field.slice(0, textLimit) : undefined;
  };
  const cause = read("cause");
  const errors = read("errors");
  const result = {
    name: text("name"),
    message: text("message"),
    stack: text("stack"),
    diff: text("diff"),
    ...(cause !== undefined ? { cause: failureDetails(cause, seen, budget, depth + 1) } : {}),
    ...(Array.isArray(errors)
      ? {
          errors: errors
            .slice(0, 4)
            .map((error: unknown) => failureDetails(error, seen, budget, depth + 1)),
          ...(errors.length > 4 ? { omittedErrors: errors.length - 4 } : {}),
        }
      : {}),
  };
  seen.delete(value);
  return result;
}

/** Emit failures when they finish, before the full suite's final summary. */
export class FailureDetailsReporter implements Reporter {
  onTestCaseResult(test: TestCase): void {
    const result = test.result();
    if (result.state !== "failed") return;
    const budget = { nodes: 0 };
    process.stderr.write(
      `${JSON.stringify({
        failure: test.fullName,
        project: test.project.name,
        file: test.module.relativeModuleId,
        errors: result.errors.slice(0, 4).map((error) => failureDetails(error, new Set(), budget)),
      })}\n`,
    );
  }
}
