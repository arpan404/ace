/*
 * What a delegation's call handed out, read from its arguments for the job's line in the fold.
 */

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * How many tasks a delegation's call handed out, from its arguments (`{tasks: [...]}`, or the
 * same inside `call_tool`'s `{name, arguments}`); undefined when they don't say.
 */
export function delegatedTasks(argumentsValue: unknown): number | undefined {
  const outer = record(argumentsValue);
  const inner = record(outer?.arguments) ?? outer;
  const tasks = inner?.tasks;
  return Array.isArray(tasks) && tasks.length > 0 ? tasks.length : undefined;
}
