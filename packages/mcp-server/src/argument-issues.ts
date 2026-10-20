import type { z } from "zod";
import type { PublicIssue } from "./public-error.ts";

/**
 * Field-level argument problems an agent can fix without guessing: the path and what the schema
 * expects. Built from issue codes and the schema itself (field names, variant names), never from
 * the value that was sent, so arguments (which may hold secrets) are not echoed back.
 */
export function argumentIssues(error: z.ZodError, schema?: z.ZodType): PublicIssue[] {
  const issues: PublicIssue[] = [];
  for (const issue of error.issues) {
    if (issues.length >= 16) break;
    if (issue.code === "unrecognized_keys") {
      const fields = fieldNames(schema, issue.path);
      for (const key of issue.keys.slice(0, 16 - issues.length))
        issues.push({
          path: render([...issue.path, key]),
          expected: clip(
            fields.length
              ? `no such field; fields here: ${fields.join(", ")}`
              : "no such field: remove it, or check the spelling against the schema",
          ),
        });
      continue;
    }
    issues.push({ path: render(issue.path), expected: expectation(issue) });
  }
  return issues;
}

/** Whether these issues are about the arguments' shape (a field or variant that does not exist). */
export function shapeIssue(error: z.ZodError): boolean {
  return error.issues.some(
    (issue) => issue.code === "unrecognized_keys" || issue.code === "invalid_union",
  );
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
      return clip(unionExpectation(issue));
    case "custom":
      // Custom messages come from ace's own schema refinements.
      return clip(issue.message);
    default:
      return "a value matching the schema";
  }
}

/** The variants a union allows: a discriminator's values, or each branch's expected type. */
function unionExpectation(issue: z.core.$ZodIssueInvalidUnion): string {
  // A discriminated union names its variants (schema literals, not the sent value).
  const options: unknown = Reflect.get(issue, "options");
  if (Array.isArray(options) && options.length)
    return `one of ${options.map((option) => JSON.stringify(option)).join(", ")}`;
  const branches = issue.errors.flatMap((branch) => {
    const [first] = branch;
    return first && first.path.length === 0 && first.code === "invalid_type"
      ? [first.expected]
      : [];
  });
  return branches.length === issue.errors.length && branches.length
    ? [...new Set(branches)].join(" or ")
    : "one of the documented shapes for this field";
}

/** The field names of the object schema at `path`, when the schema has a plain object there. */
function fieldNames(schema: z.ZodType | undefined, path: readonly PropertyKey[]): string[] {
  let node = unwrap(schema);
  for (const segment of path) {
    if (!node) return [];
    const def = node._zod.def;
    if (typeof segment === "number" && def.type === "array" && "element" in def)
      node = unwrap(def.element as z.ZodType);
    else if (typeof segment === "string" && def.type === "object" && "shape" in def)
      node = unwrap((def.shape as Record<string, z.ZodType>)[segment]);
    else return [];
  }
  const def = node?._zod.def;
  return def?.type === "object" && "shape" in def
    ? Object.keys(def.shape as Record<string, unknown>).slice(0, 40)
    : [];
}

/** The schema inside optional, default, nullable and refinement wrappers. */
function unwrap(schema: z.ZodType | undefined): z.ZodType | undefined {
  let node = schema;
  for (let depth = 0; node && depth < 8; depth++) {
    const def = node._zod.def;
    if ("innerType" in def) node = def.innerType as z.ZodType;
    else if (def.type === "pipe" && "in" in def) node = def.in as z.ZodType;
    else return node;
  }
  return node;
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
