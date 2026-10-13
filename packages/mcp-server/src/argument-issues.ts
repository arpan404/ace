import type { z } from "zod";
import type { PublicIssue } from "./public-error.ts";

/**
 * Field-level argument problems an agent can fix without guessing: the path and what the schema
 * expects. Built from issue codes and schema metadata only, never from the value that was sent,
 * so arguments (which may hold secrets) are not echoed back.
 */
export function argumentIssues(error: z.ZodError): PublicIssue[] {
  const issues: PublicIssue[] = [];
  for (const issue of error.issues) {
    if (issues.length >= 16) break;
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys.slice(0, 16 - issues.length))
        issues.push({
          path: render([...issue.path, key]),
          expected: "no such field: remove it, or check the spelling against the schema",
        });
      continue;
    }
    issues.push({ path: render(issue.path), expected: expectation(issue) });
  }
  return issues;
}

function expectation(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.message.endsWith("received undefined")
        ? `required ${issue.expected}, missing`
        : `${issue.expected}`;
    case "invalid_value":
      return clip(`one of ${issue.values.map((value) => JSON.stringify(value)).join(", ")}`);
    case "too_big":
      return `${issue.origin} ${issue.inclusive === false ? "<" : "<="} ${String(issue.maximum)}${issue.origin === "string" || issue.origin === "array" ? " in length" : ""}`;
    case "too_small":
      return `${issue.origin} ${issue.inclusive === false ? ">" : ">="} ${String(issue.minimum)}${issue.origin === "string" || issue.origin === "array" ? " in length" : ""}`;
    case "invalid_format":
      return `${issue.format} format`;
    case "not_multiple_of":
      return `a multiple of ${String(issue.divisor)}`;
    case "invalid_union":
      return "one of the documented shapes for this field";
    case "custom":
      // Custom messages come from ace's own schema refinements.
      return clip(issue.message);
    default:
      return "a value matching the schema";
  }
}

function render(path: readonly PropertyKey[]): string {
  if (!path.length) return "(arguments)";
  let out = "";
  for (const segment of path)
    out +=
      typeof segment === "number"
        ? `[${segment}]`
        : `${out ? "." : ""}${typeof segment === "string" && /^[\w$-]{1,64}$/.test(segment) ? segment : "<field>"}`;
  return out.slice(0, 160);
}

const clip = (text: string) => (text.length > 240 ? `${text.slice(0, 237)}...` : text);
