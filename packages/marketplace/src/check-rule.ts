import { refusal, type Refusal } from "./rules.ts";
import { schemaLimits, type Misfit } from "./schema.ts";

/*
 * A `schema` check's rule (ADR 0204 §3), read the way Spade reads it (`spade_core::quality::rule`):
 * the contract subset's keywords plus `pattern`, with `type` and every bound optional, since a
 * rule only narrows a value the contract's or card's own schema already bounds. The shared cases
 * in `spade/spec/conformance/package/check-rules.json` hold both readers to it. A `pattern` is
 * written in the part of regular expressions Rust's `regex` and `RegExp` with the `u` and `s`
 * flags read the same way; `checkPatternProblem` refuses the rest before either compiles it.
 */

export const ruleLimits = { patternChars: 200, mostRepeat: 1_000 } as const;

const objectKeywords = new Set(["properties", "required"]);
const stringKeywords = new Set(["minLength", "maxLength", "enum", "pattern"]);
const numberKeywords = new Set(["minimum", "maximum"]);
const arrayKeywords = new Set(["items", "minItems", "maxItems"]);
const common = new Set(["type", "description", "title"]);
const types = new Set(["object", "string", "number", "integer", "boolean", "array"]);

type Narrowed = "object" | "string" | "number" | "array";

/** One rule, read. */
export type CheckRule = {
  kind?: string;
  narrows:
    | { kind: "nothing" }
    | { kind: "object"; fields: Record<string, CheckRule>; required: string[] }
    | { kind: "string"; min?: number; max?: number; oneOf?: string[]; pattern?: [string, RegExp] }
    | { kind: "number"; min?: number; max?: number }
    | { kind: "array"; items?: CheckRule; min?: number; max?: number };
};

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function kindOf(keyword: string): Narrowed | undefined {
  if (objectKeywords.has(keyword)) return "object";
  if (stringKeywords.has(keyword)) return "string";
  if (numberKeywords.has(keyword)) return "number";
  if (arrayKeywords.has(keyword)) return "array";
  return undefined;
}

const fieldName = (name: string) => /^[A-Za-z0-9_]{1,64}$/.test(name);

function count(
  fields: Fields,
  key: string,
  most: number,
  at: string,
  out: Refusal[],
): number | undefined {
  const value = fields[key];
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= most)
    return value;
  out.push(refusal("check-rule.bound", `${at}.${key} is a whole number up to ${most}`));
  return undefined;
}

function bound(fields: Fields, key: string, at: string, out: Refusal[]): number | undefined {
  const value = fields[key];
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  out.push(refusal("check-rule.bound", `${at}.${key} is a number`));
  return undefined;
}

/** The characters a backslash escapes outside a class, and inside one. */
const escaped = "^$\\.*+?()[]{}|/";
const escapedInClass = "^$\\.*+?()[]{}|/-";

const whole = (t: string) => /^[0-9]{1,4}$/.test(t) && Number(t) <= ruleLimits.mostRepeat;

function repeat(inside: string): boolean {
  const comma = inside.indexOf(",");
  if (comma < 0) return whole(inside);
  const [low, high] = [inside.slice(0, comma), inside.slice(comma + 1)];
  if (high === "") return whole(low);
  return whole(low) && whole(high) && Number(low) <= Number(high);
}

/** Why `pattern` is outside the subset both regex readers agree on; undefined when it is in it. */
export function checkPatternProblem(pattern: string): string | undefined {
  const chars = [...pattern];
  if (chars.length === 0 || chars.length > ruleLimits.patternChars)
    return `is 1 to ${ruleLimits.patternChars} characters`;
  let at = 0;
  let inClass = false;
  while (at < chars.length) {
    const c = chars[at] ?? "";
    if (c === "\\") {
      const next = chars[at + 1];
      if (next === undefined) return "ends in a lone backslash";
      if (!(inClass ? escapedInClass : escaped).includes(next))
        return `escapes only punctuation: write \\${next} another way (a class like [0-9] for \\d)`;
      at += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      else if (c === "[") return "escapes a [ inside a class";
      else if ((c === "&" || c === "-" || c === "~") && chars[at + 1] === c)
        return `doesn't use ${c}${c} inside a class`;
      at += 1;
      continue;
    }
    if (c === "[") {
      let next = at + 1;
      if (chars[next] === "^") next += 1;
      if (chars[next] === "]") return "has no empty class";
      inClass = true;
      at = next;
      continue;
    }
    if (c === "]" || c === "}") return `escapes a ${c} outside a class`;
    if (c === "(" && chars[at + 1] === "?") return "has no (?…) groups";
    if (c === "{") {
      const close = chars.indexOf("}", at);
      if (close < 0 || !repeat(chars.slice(at + 1, close).join("")))
        return `repeats with {n}, {n,} or {n,m}, each at most ${ruleLimits.mostRepeat}; escape a { meant as text`;
      at = close + 1;
      continue;
    }
    at += 1;
  }
  return inClass ? "closes every class it opens" : undefined;
}

function node(value: unknown, at: string, depth: number, out: Refusal[]): CheckRule | undefined {
  if (depth > schemaLimits.depth) {
    out.push(
      refusal("check-rule.depth", `${at}: a rule nests at most ${schemaLimits.depth} levels`),
    );
    return undefined;
  }
  if (!isFields(value)) {
    out.push(refusal("check-rule.object", `${at} is a rule object`));
    return undefined;
  }
  const before = out.length;
  let narrowed: Narrowed | undefined;
  for (const key of Object.keys(value)) {
    if (common.has(key)) continue;
    const kind = kindOf(key);
    if (kind === undefined)
      out.push(
        refusal(
          "check-rule.keyword",
          `${at}: ${JSON.stringify(key)} isn't in the rule subset checks use`,
        ),
      );
    else if (narrowed !== undefined && narrowed !== kind)
      out.push(refusal("check-rule.mixed", `${at} mixes keywords of different types`));
    else narrowed = kind;
  }
  for (const key of ["description", "title"]) {
    const text = value[key];
    if (
      text !== undefined &&
      (typeof text !== "string" || [...text].length > schemaLimits.descriptionChars)
    )
      out.push(
        refusal(
          "check-rule.text",
          `${at}.${key} is text of at most ${schemaLimits.descriptionChars} characters`,
        ),
      );
  }
  const type = value["type"];
  let kind: string | undefined;
  if (type !== undefined) {
    if (typeof type === "string" && types.has(type)) kind = type;
    else
      out.push(
        refusal(
          "check-rule.type",
          `${at}.type is object, string, number, integer, boolean or array`,
        ),
      );
  }
  if (kind !== undefined && narrowed !== undefined) {
    const same = kind === narrowed || (kind === "integer" && narrowed === "number");
    if (!same)
      out.push(
        refusal("check-rule.type", `${at}: a ${kind} takes none of the ${narrowed} keywords`),
      );
  }
  if (out.length > before) return undefined;
  let narrows: CheckRule["narrows"] = { kind: "nothing" };
  if (narrowed === "object") {
    const fields: Record<string, CheckRule> = {};
    const properties = value["properties"];
    if (properties !== undefined) {
      if (!isFields(properties) || Object.keys(properties).length > schemaLimits.fields)
        out.push(
          refusal(
            "check-rule.fields",
            `${at}.properties names at most ${schemaLimits.fields} fields`,
          ),
        );
      else
        for (const [name, item] of Object.entries(properties)) {
          if (!fieldName(name)) {
            out.push(
              refusal(
                "check-rule.fields",
                `${at}.properties: ${JSON.stringify(name)} is a field name of 1 to 64 letters, digits and _`,
              ),
            );
            continue;
          }
          const rule = node(item, `${at}.${name}`, depth + 1, out);
          if (rule) fields[name] = rule;
        }
    }
    const required = value["required"];
    let names: string[] = [];
    if (required !== undefined) {
      const listed = Array.isArray(required)
        ? required.filter((name): name is string => typeof name === "string" && fieldName(name))
        : [];
      if (
        Array.isArray(required) &&
        required.length <= schemaLimits.fields &&
        listed.length === required.length
      )
        names = listed;
      else out.push(refusal("check-rule.required", `${at}.required is a list of field names`));
    }
    narrows = { kind: "object", fields, required: names };
  } else if (narrowed === "string") {
    const min = count(value, "minLength", schemaLimits.longestString, at, out);
    const max = count(value, "maxLength", schemaLimits.longestString, at, out);
    if (min !== undefined && max !== undefined && min > max)
      out.push(refusal("check-rule.bound", `${at}: minLength is more than maxLength`));
    let oneOf: string[] | undefined;
    const words = value["enum"];
    if (words !== undefined) {
      if (!Array.isArray(words) || words.length < 1 || words.length > schemaLimits.enum)
        out.push(refusal("check-rule.enum", `${at}.enum lists 1 to ${schemaLimits.enum} words`));
      else {
        const listed = words.filter(
          (w): w is string => typeof w === "string" && [...w].length <= schemaLimits.enumChars,
        );
        if (listed.length !== words.length)
          out.push(
            refusal(
              "check-rule.enum",
              `${at}.enum lists words of at most ${schemaLimits.enumChars} characters`,
            ),
          );
        else oneOf = listed;
      }
    }
    let pattern: [string, RegExp] | undefined;
    const text = value["pattern"];
    if (text !== undefined) {
      if (typeof text !== "string")
        out.push(refusal("check-rule.pattern", `${at}.pattern is text`));
      else {
        const why = checkPatternProblem(text);
        if (why) out.push(refusal("check-rule.pattern", `${at}.pattern ${why}`));
        else
          try {
            pattern = [text, new RegExp(text, "su")];
          } catch {
            out.push(
              refusal("check-rule.pattern", `${at}.pattern isn't a pattern this subset reads`),
            );
          }
      }
    }
    narrows = {
      kind: "string",
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(oneOf ? { oneOf } : {}),
      ...(pattern ? { pattern } : {}),
    };
  } else if (narrowed === "number") {
    const [min, max] = [bound(value, "minimum", at, out), bound(value, "maximum", at, out)];
    if (min !== undefined && max !== undefined && min > max)
      out.push(refusal("check-rule.bound", `${at}: minimum is more than maximum`));
    narrows = {
      kind: "number",
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    };
  } else if (narrowed === "array") {
    const min = count(value, "minItems", schemaLimits.items, at, out);
    const max = count(value, "maxItems", schemaLimits.items, at, out);
    if (min !== undefined && max !== undefined && min > max)
      out.push(refusal("check-rule.bound", `${at}: minItems is more than maxItems`));
    let items: CheckRule | undefined;
    if (value["items"] !== undefined) {
      items = node(value["items"], `${at}.items`, depth + 1, out);
      if (!items) return undefined;
    }
    narrows = {
      kind: "array",
      ...(items ? { items } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    };
  }
  if (out.length > before) return undefined;
  return { ...(kind ? { kind } : {}), narrows };
}

/** `value` read as a rule, or every problem at its place (`at` names it, `checks[0].rule`). */
export function readCheckRule(
  value: unknown,
  at: string,
): { rule: CheckRule | undefined; problems: Refusal[] } {
  if ((JSON.stringify(value) ?? "").length > schemaLimits.schemaBytes)
    return {
      rule: undefined,
      problems: [
        refusal("check-rule.size", `${at} is longer than ${schemaLimits.schemaBytes / 1024} KiB`),
      ],
    };
  const problems: Refusal[] = [];
  const rule = node(value, at, 1, problems);
  return { rule: problems.length ? undefined : rule, problems };
}

const kindWords: Record<string, string> = {
  object: "an object",
  string: "text",
  number: "a number",
  integer: "a whole number",
  boolean: "true or false",
  array: "a list",
};

function ofKind(kind: string, value: unknown): boolean {
  switch (kind) {
    case "object":
      return isFields(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return Array.isArray(value);
  }
}

/** Every place `value` misses `rule`, under `at` (`output`); empty when it holds. */
export function checkRule(rule: CheckRule, value: unknown, at: string): Misfit[] {
  const out: Misfit[] = [];
  walk(rule, value, at, out);
  return out;
}

function walk(rule: CheckRule, value: unknown, at: string, out: Misfit[]) {
  if (out.length >= 20) return;
  const miss = (why: string) => out.push({ at, why });
  if (rule.kind !== undefined && !ofKind(rule.kind, value)) {
    miss(`is ${kindWords[rule.kind]}`);
    return;
  }
  const narrows = rule.narrows;
  switch (narrows.kind) {
    case "nothing":
      return;
    case "object":
      if (!isFields(value)) return void miss("is an object");
      for (const name of narrows.required)
        if (!(name in value)) out.push({ at: `${at}.${name}`, why: "is missing" });
      for (const [name, item] of Object.entries(narrows.fields))
        if (name in value) walk(item, value[name], `${at}.${name}`, out);
      return;
    case "string": {
      if (typeof value !== "string") return void miss("is text");
      const length = [...value].length;
      if (narrows.oneOf && !narrows.oneOf.includes(value))
        miss(`is one of ${narrows.oneOf.join(", ")}`);
      else if (narrows.max !== undefined && length > narrows.max)
        miss(`is at most ${narrows.max} characters`);
      else if (narrows.min !== undefined && length < narrows.min)
        miss(`is at least ${narrows.min} characters`);
      else if (narrows.pattern && !narrows.pattern[1].test(value))
        miss(`doesn't match ${narrows.pattern[0]}`);
      return;
    }
    case "number":
      if (typeof value !== "number") return void miss("is a number");
      if (narrows.min !== undefined && value < narrows.min) miss(`is at least ${narrows.min}`);
      else if (narrows.max !== undefined && value > narrows.max) miss(`is at most ${narrows.max}`);
      return;
    case "array":
      if (!Array.isArray(value)) return void miss("is a list");
      if (narrows.max !== undefined && value.length > narrows.max)
        miss(`holds at most ${narrows.max} items`);
      else if (narrows.min !== undefined && value.length < narrows.min)
        miss(`holds at least ${narrows.min} items`);
      const items = narrows.items;
      if (items)
        value
          .slice(0, schemaLimits.items)
          .forEach((item, i) => walk(items, item, `${at}[${i}]`, out));
  }
}
