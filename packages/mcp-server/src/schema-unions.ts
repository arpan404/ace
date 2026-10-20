/**
 * Shorter spellings of two union shapes Zod emits, for the schemas a model reads. Both keep
 * every value the union accepts in the advertised schema; the registry still validates each
 * call against the full Zod schema, so a value the flat form allows but a variant forbids gets
 * an `invalid_arguments` issue naming the field.
 *
 * - String choices (`anyOf: [{const: "inherit"}, {enum: [...]}]`) become one `enum`.
 * - Object variants told apart by one constant field (a discriminated union) become one object:
 *   the discriminator as an enum, every variant's other fields optional, only fields every
 *   variant requires kept required. Unions whose variants give one field different schemas
 *   stay as they are.
 */
type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keys a variant may carry and still merge; anything else (a description, a pattern) keeps it apart. */
const choiceKeys = new Set(["type", "const", "enum"]);

/** One schema accepting every variant's values, or undefined to keep the union as it is. */
export function flatUnion(variants: readonly unknown[]): Json | undefined {
  if (variants.length < 2 || !variants.every(isRecord)) return undefined;
  return stringChoices(variants) ?? discriminated(variants);
}

function stringChoices(variants: readonly Json[]): Json | undefined {
  const values: unknown[] = [];
  for (const variant of variants) {
    if (variant["type"] !== "string" || Object.keys(variant).some((key) => !choiceKeys.has(key)))
      return undefined;
    if ("const" in variant) values.push(variant["const"]);
    else if (Array.isArray(variant["enum"])) values.push(...variant["enum"]);
    else return undefined;
  }
  return { type: "string", enum: [...new Set(values)] };
}

const objectKeys = new Set(["type", "properties", "required", "additionalProperties"]);

function discriminated(variants: readonly Json[]): Json | undefined {
  const shapes: { properties: Json; required: string[] }[] = [];
  for (const variant of variants) {
    if (variant["type"] !== "object" || Object.keys(variant).some((key) => !objectKeys.has(key)))
      return undefined;
    const properties = variant["properties"];
    const required = variant["required"];
    if (!isRecord(properties)) return undefined;
    shapes.push({
      properties,
      required: Array.isArray(required) ? required.filter((name) => typeof name === "string") : [],
    });
  }
  const tag = discriminator(shapes);
  if (tag === undefined) return undefined;
  const merged: Json = {
    [tag]: { type: "string", enum: shapes.map((shape) => constOf(shape.properties[tag])) },
  };
  for (const { properties } of shapes)
    for (const [name, schema] of Object.entries(properties)) {
      if (name === tag) continue;
      const known = merged[name];
      if (known !== undefined && JSON.stringify(known) !== JSON.stringify(schema)) return undefined;
      merged[name] = schema;
    }
  const required = shapes
    .map((shape) => shape.required)
    .reduce((common, next) => common.filter((name) => next.includes(name)));
  return { type: "object", properties: merged, required };
}

const constOf = (schema: unknown) => (isRecord(schema) ? schema["const"] : undefined);

/** The one field every variant requires as a distinct string constant. */
function discriminator(shapes: readonly { properties: Json; required: string[] }[]) {
  const [first] = shapes;
  if (!first) return undefined;
  return Object.keys(first.properties).find((name) => {
    const values = shapes.map((shape) =>
      shape.required.includes(name) ? constOf(shape.properties[name]) : undefined,
    );
    return (
      values.every((value) => typeof value === "string") && new Set(values).size === values.length
    );
  });
}
