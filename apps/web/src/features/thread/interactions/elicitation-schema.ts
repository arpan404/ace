import { z } from "zod";

const Primitive = z.union([z.string(), z.boolean(), z.number()]);
const Property = z.strictObject({
  type: z.enum(["string", "boolean", "number", "integer"]),
  title: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(Primitive).min(1).max(128).optional(),
  enumNames: z.array(z.string()).optional(),
  default: Primitive.optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
});
const Form = z.strictObject({
  type: z.literal("object"),
  title: z.string().optional(),
  description: z.string().optional(),
  $schema: z.string().optional(),
  properties: z.record(z.string(), Property),
  required: z.array(z.string()).default([]),
  additionalProperties: z.boolean().optional(),
});
export type ElicitationForm = z.infer<typeof Form>;
export function elicitationForm(schema: unknown): ElicitationForm | undefined {
  const parsed = Form.safeParse(schema);
  if (
    !parsed.success ||
    Object.keys(parsed.data.properties).length > 64 ||
    parsed.data.required.some((key) => !(key in parsed.data.properties))
  )
    return undefined;
  return parsed.data;
}

/** Decode the typed form values and validate the supported primitive constraints. */
export function elicitationContent(
  form: ElicitationForm,
  values: Readonly<Record<string, string>>,
) {
  const content = new Map<string, z.infer<typeof Primitive>>();
  const errors = new Map<string, string>();
  for (const [key, property] of Object.entries(form.properties)) {
    const raw = values[key] ?? (property.default === undefined ? "" : String(property.default));
    const label = property.title ?? key;
    if (!raw.length) {
      if (form.required.includes(key)) errors.set(key, `${label} is required.`);
      continue;
    }
    const value =
      property.type === "boolean"
        ? raw === "true"
          ? true
          : raw === "false"
            ? false
            : undefined
        : property.type === "number" || property.type === "integer"
          ? Number(raw)
          : raw;
    const invalid =
      value === undefined ||
      (typeof value === "number" &&
        (!Number.isFinite(value) ||
          (property.type === "integer" && !Number.isInteger(value)) ||
          (property.minimum !== undefined && value < property.minimum) ||
          (property.maximum !== undefined && value > property.maximum))) ||
      (typeof value === "string" &&
        ((property.minLength !== undefined && value.length < property.minLength) ||
          (property.maxLength !== undefined && value.length > property.maxLength))) ||
      (property.enum !== undefined && !property.enum.includes(value));
    if (invalid) errors.set(key, `Enter a valid ${label}.`);
    else content.set(key, value);
  }
  return { content: Object.fromEntries(content), errors, valid: errors.size === 0 };
}

export function consentUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}
