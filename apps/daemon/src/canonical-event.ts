import { Event, EventPayload } from "@ace/protocol";
import { z } from "zod";

/**
 * The writer's canonicalising step, without Zod's full parse where the schema shows it isn't
 * needed (ADR 0125, point 4). `Event.parse` checks an event and rebuilds it in this build's shape:
 * keys in schema order, unknown keys dropped, defaults filled. For a payload variant whose
 * fields are all flat (strings, numbers, booleans, literals and enums, optional or nullable,
 * with only length and range checks) there is nothing to fill, so the same checks and the same
 * rebuild are done here directly, with one new object per level. The plans are read off the
 * schema once, at first use; a variant with anything else in it (a nested object, a default,
 * a transform, a refinement, a check not listed below) has no plan and goes to `Event.parse`.
 * So does every input a plan rejects, which keeps Zod's error for it.
 */
export function canonicalEvent(input: unknown): Event {
  const fast = plans().event(input);
  return fast ?? Event.parse(input);
}

/**
 * One field's checks as data, read by `passes`: one shape for every field, so the hot loop
 * stays monomorphic. Bounds absent from the schema are infinite.
 */
interface Field {
  key: string;
  optional: boolean;
  nullable: boolean;
  kind: "string" | "number" | "boolean" | "one of";
  /** Length bounds for a string, value bounds for a number. */
  min: number;
  minInclusive: boolean;
  max: number;
  maxInclusive: boolean;
  integer: boolean;
  values: ReadonlySet<unknown>;
}
type Build = (input: unknown) => Record<string, unknown> | undefined;
const none: ReadonlySet<unknown> = new Set();

function passes(field: Field, value: unknown): boolean {
  if (value === null) return field.nullable;
  switch (field.kind) {
    case "string":
      return typeof value === "string" && value.length >= field.min && value.length <= field.max;
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (!field.integer || Number.isSafeInteger(value)) &&
        (field.minInclusive ? value >= field.min : value > field.min) &&
        (field.maxInclusive ? value <= field.max : value < field.max)
      );
    case "boolean":
      return typeof value === "boolean";
    case "one of":
      return field.values.has(value);
  }
}

/** A flat object's plan: the checks of its fields, and the rebuild in schema order. */
function flatObject(schema: z.ZodObject): Build | undefined {
  if (schema.def.catchall !== undefined || schema.def.checks?.length) return undefined;
  const fields: Field[] = [];
  for (const [key, field] of Object.entries(schema.shape)) {
    const plan = fieldPlan(key, field);
    if (!plan) return undefined;
    fields.push(plan);
  }
  return (input) => {
    if (!isRecord(input)) return undefined;
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const value = input[field.key];
      if (value === undefined && field.optional) {
        // Zod keeps an optional key that is present as undefined, and omits an absent one.
        if (field.key in input) out[field.key] = undefined;
        continue;
      }
      if (!passes(field, value)) return undefined;
      out[field.key] = value;
    }
    return out;
  };
}

function fieldPlan(key: string, schema: z.core.$ZodType): Field | undefined {
  let optional = false;
  let nullable = false;
  let at = schema;
  for (;;) {
    if (at instanceof z.ZodOptional && !optional && !nullable) optional = true;
    else if (at instanceof z.ZodNullable && !nullable) nullable = true;
    else break;
    if (at.def.checks?.length) return undefined;
    at = at.def.innerType;
  }
  const base = { key, optional, nullable, integer: false, values: none };
  const unbounded = { min: -Infinity, minInclusive: true, max: Infinity, maxInclusive: true };
  const checks = at instanceof z.ZodType ? (at.def.checks ?? []) : [];
  if (at instanceof z.ZodString) {
    const field: Field = { ...base, ...unbounded, kind: "string", min: 0 };
    for (const check of checks) {
      if (check instanceof z.core.$ZodCheckMinLength)
        field.min = Math.max(field.min, defOf(check).minimum);
      else if (check instanceof z.core.$ZodCheckMaxLength)
        field.max = Math.min(field.max, defOf(check).maximum);
      else return undefined;
    }
    return field;
  }
  if (at instanceof z.ZodNumber) {
    const field: Field = { ...base, ...unbounded, kind: "number" };
    for (const check of checks) {
      if (check instanceof z.core.$ZodCheckNumberFormat) {
        if (defOf(check).format !== "safeint") return undefined;
        field.integer = true;
      } else if (check instanceof z.core.$ZodCheckGreaterThan) {
        const { value, inclusive } = defOf(check);
        if (typeof value !== "number") return undefined;
        if (value > field.min || (value === field.min && !inclusive)) {
          field.min = value;
          field.minInclusive = inclusive;
        }
      } else if (check instanceof z.core.$ZodCheckLessThan) {
        const { value, inclusive } = defOf(check);
        if (typeof value !== "number") return undefined;
        if (value < field.max || (value === field.max && !inclusive)) {
          field.max = value;
          field.maxInclusive = inclusive;
        }
      } else return undefined;
    }
    return field;
  }
  if (checks.length) return undefined;
  if (at instanceof z.ZodBoolean) return { ...base, ...unbounded, kind: "boolean" };
  if (at instanceof z.ZodLiteral)
    return { ...base, ...unbounded, kind: "one of", values: new Set<unknown>(at.def.values) };
  if (at instanceof z.ZodEnum)
    return {
      ...base,
      ...unbounded,
      kind: "one of",
      values: new Set<unknown>(Object.values(at.def.entries)),
    };
  return undefined;
}

/** A check's definition: what it checks, with its bound. Zod keeps it only on `_zod`. */
function defOf<T extends { _zod: { def: unknown } }>(check: T): T["_zod"]["def"] {
  // oxlint-disable-next-line no-underscore-dangle -- Zod's own check definition.
  return check._zod.def;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Plans {
  event(input: unknown): Event | undefined;
  /** The payload types that have a plan. */
  types: ReadonlySet<string>;
}

let built: Plans | undefined;
function plans(): Plans {
  built ??= buildPlans();
  return built;
}

function buildPlans(): Plans {
  const variants = new Map<unknown, Build>();
  for (const option of EventPayload.options) {
    const build = flatObject(option);
    if (build) for (const type of option.shape.type.def.values) variants.set(type, build);
  }
  const { payload, ...envelopeShape } = Event.shape;
  // Event.parse puts `payload` where the shape has it, which the rebuild below takes as last.
  const payloadLast = Object.keys(Event.shape).at(-1) === "payload";
  const envelope =
    payload === EventPayload && payloadLast ? flatObject(z.object(envelopeShape)) : undefined;
  const types = new Set([...variants.keys()].filter((type) => typeof type === "string"));
  if (!envelope || Event.def.catchall !== undefined || Event.def.checks?.length)
    return { event: () => undefined, types: new Set() };
  return {
    types,
    event(input) {
      if (!isRecord(input) || !isRecord(input.payload)) return undefined;
      const build = variants.get(input.payload.type);
      if (!build) return undefined;
      const head = envelope(input);
      const body = head && build(input.payload);
      if (!head || !body) return undefined;
      head.payload = body;
      // Trusted: every field passed the schema's own checks, rebuilt as Event.parse would.
      return head as Event;
    },
  };
}

/** The payload types canonicalised without `Event.parse`; tests read it to cover each one. */
export function plannedPayloadTypes(): ReadonlySet<string> {
  return plans().types;
}
