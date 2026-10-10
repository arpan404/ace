import type { Reporter, TestCase } from "vitest/node";

const textLimit = 8_000;
const nodeLimit = 20;
function errorList(
  value: unknown,
  seen: Set<object>,
  budget: { nodes: number },
  depth: number,
): object {
  let length: unknown;
  try {
    if (!Array.isArray(value)) return {};
    length = Reflect.get(value, "length");
  } catch {
    return { errors: [{ truncated: "unreadable" }] };
  }
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0)
    return { errors: [{ truncated: "unreadable" }] };
  const errors: object[] = [];
  for (let index = 0; index < Math.min(length, 4); index++) {
    try {
      errors.push(failureDetails(Reflect.get(value, String(index)), seen, budget, depth));
    } catch {
      errors.push({ truncated: "unreadable" });
    }
  }
  return { errors, ...(length > 4 ? { omittedErrors: length - 4 } : {}) };
}
function failureDetails(
  value: unknown,
  seen: Set<object>,
  budget: { nodes: number },
  depth = 0,
): object {
  if (budget.nodes++ >= nodeLimit) return { truncated: "capacity" };
  if (depth >= 5) return { truncated: "depth" };
  if (typeof value !== "object" || value === null) {
    try {
      return { message: String(value).slice(0, textLimit) };
    } catch {
      return { truncated: "unreadable" };
    }
  }
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
    ...errorList(errors, seen, budget, depth + 1),
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
        ...errorList(result.errors, new Set(), budget, 0),
      })}\n`,
    );
  }
}
