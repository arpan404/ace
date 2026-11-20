/*
 * A data schema a package declares (ADR 0200 §5): a panel's state and each of its actions' values,
 * as a bounded subset of JSON Schema, read the way Spade reads it (`spade_core::schema::read`):
 * objects with known fields, strings with a length, arrays with a size, at most six levels deep,
 * and no keyword this build doesn't enforce. `package/rules.json` holds both readers to the same
 * sentences. Spade checks the data itself; the market only reads declarations. Pure.
 */

const mostDepth = 6;
const mostProperties = 64;
const mostWords = 64;
const wordChars = 200;
const mostText = 10_000;
const mostItems = 1_000;

const types = "object, array, string, number, integer or boolean";

const keywords: Record<string, readonly string[]> = {
  object: ["type", "properties", "required", "description", "title"],
  array: ["type", "items", "minItems", "maxItems", "description", "title"],
  string: ["type", "minLength", "maxLength", "enum", "description", "title"],
  number: ["type", "minimum", "maximum", "description", "title"],
  integer: ["type", "minimum", "maximum", "description", "title"],
  boolean: ["type", "description", "title"],
};

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const whole = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
const chars = (text: string) => [...text].length;
const fieldName = (name: string) => name.length <= 64 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

/** Every problem with the declaration at `at` (`surfaces[1].state`); none when it reads. */
export function schemaProblems(value: unknown, at: string): string[] {
  const problems: string[] = [];
  node(value, at, 1, problems);
  return problems;
}

function node(value: unknown, at: string, depth: number, problems: string[]): void {
  if (!isFields(value)) {
    problems.push(`${at} is a schema: an object with a type`);
    return;
  }
  if (depth > mostDepth) {
    problems.push(`${at} is nested more than ${mostDepth} levels deep`);
    return;
  }
  const kind =
    typeof value["type"] === "string" && keywords[value["type"]]
      ? value["type"]
      : value["type"] === undefined && "enum" in value
        ? "string"
        : undefined;
  if (kind === undefined) {
    problems.push(`${at}.type is ${types}`);
    return;
  }
  for (const key of Object.keys(value))
    if (!keywords[kind]?.includes(key))
      problems.push(`${at}: ${key} isn't a keyword this Spade reads for ${kind}`);
  for (const [key, most] of [
    ["description", 500],
    ["title", 120],
  ] as const) {
    const about = value[key];
    if (about !== undefined && (typeof about !== "string" || chars(about) > most))
      problems.push(`${at}.${key} is text of at most ${most} characters`);
  }
  if (kind === "object") object(value, at, depth, problems);
  else if (kind === "array") array(value, at, depth, problems);
  else if (kind === "string") words(value, at, problems);
  else if (kind === "number" || kind === "integer") number(value, at, problems);
}

function object(value: Fields, at: string, depth: number, problems: string[]): void {
  const listed = value["properties"];
  if (!isFields(listed)) {
    problems.push(`${at}.properties names the object's fields`);
    return;
  }
  const names = Object.keys(listed);
  if (names.length > mostProperties) {
    problems.push(`${at}.properties has at most ${mostProperties} fields`);
    return;
  }
  for (const name of names) {
    if (!fieldName(name)) {
      problems.push(`${at}.properties names fields with letters, digits and underscores`);
      continue;
    }
    node(listed[name], `${at}.properties.${name}`, depth + 1, problems);
  }
  const required = value["required"];
  if (
    required !== undefined &&
    !(
      Array.isArray(required) &&
      required.every((name) => typeof name === "string" && Object.hasOwn(listed, name))
    )
  )
    problems.push(`${at}.required names its own properties`);
}

function array(value: Fields, at: string, depth: number, problems: string[]): void {
  const most = whole(value["maxItems"]);
  const max = most !== undefined && most >= 1 && most <= mostItems ? most : 0;
  if (max === 0) problems.push(`${at}.maxItems bounds the list (1 to ${mostItems})`);
  if (value["minItems"] !== undefined) {
    const least = whole(value["minItems"]);
    if (least === undefined || least > max)
      problems.push(`${at}.minItems is a count no more than maxItems`);
  }
  if (value["items"] === undefined) {
    problems.push(`${at}.items is the schema of each item`);
    return;
  }
  node(value["items"], `${at}.items`, depth + 1, problems);
}

function words(value: Fields, at: string, problems: string[]): void {
  const listed = value["enum"];
  if (listed !== undefined) {
    const ok =
      Array.isArray(listed) &&
      listed.length >= 1 &&
      listed.length <= mostWords &&
      listed.every((word) => typeof word === "string" && word !== "" && chars(word) <= wordChars);
    if (!ok)
      problems.push(
        `${at}.enum lists 1 to ${mostWords} words, each at most ${wordChars} characters`,
      );
    else if ("maxLength" in value || "minLength" in value)
      problems.push(`${at}: an enum's words need no length`);
    return;
  }
  const most = whole(value["maxLength"]);
  if (most === undefined || most < 1 || most > mostText) {
    problems.push(`${at}.maxLength bounds the text (1 to ${mostText})`);
    return;
  }
  if (value["minLength"] !== undefined) {
    const least = whole(value["minLength"]);
    if (least === undefined || least > most)
      problems.push(`${at}.minLength is a length no more than maxLength`);
  }
}

function number(value: Fields, at: string, problems: string[]): void {
  const bound = (key: string) => {
    const n = value[key];
    if (n === undefined) return undefined;
    if (typeof n !== "number" || !Number.isFinite(n)) {
      problems.push(`${at}.${key} is a number`);
      return undefined;
    }
    return n;
  };
  const [least, most] = [bound("minimum"), bound("maximum")];
  if (least !== undefined && most !== undefined && least > most)
    problems.push(`${at}.minimum is no more than its maximum`);
}
