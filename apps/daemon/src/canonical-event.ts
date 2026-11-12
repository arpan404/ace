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

type Check = (value: unknown) => boolean;
interface Field {
  key: string;
  check: Check;
  optional: boolean;
}
type Build = (input: unknown) => Record<string, unknown> | undefined;

/** A flat object's plan: the checks of its fields, and the rebuild in schema order. */
function flatObject(schema: z.ZodObject): Build | undefined {
  if (schema.def.catchall !== undefined || schema.def.checks?.length) return undefined;
  const fields: Field[] = [];
  for (const [key, field] of Object.entries(schema.shape)) {
    const plan = fieldPlan(field);
    if (!plan) return undefined;
    fields.push({ key, ...plan });
  }
  return (input) => {
    if (!isRecord(input)) return undefined;
    const out: Record<string, unknown> = {};
    for (const { key, check, optional } of fields) {
      const value = input[key];
      if (value === undefined && optional) {
        // Zod keeps an optional key that is present as undefined, and omits an absent one.
        if (key in input) out[key] = undefined;
        continue;
      }
      if (!check(value)) return undefined;
      out[key] = value;
    }
    return out;
  };
}

function fieldPlan(schema: z.core.$ZodType): { check: Check; optional: boolean } | undefined {
  if (schema instanceof z.ZodOptional) {
    if (schema.def.checks?.length) return undefined;
    const inner = leaf(schema.def.innerType);
    return inner && { check: inner, optional: true };
  }
  const check = leaf(schema);
  return check && { check, optional: false };
}

function leaf(schema: z.core.$ZodType): Check | undefined {
  if (schema instanceof z.ZodNullable) {
    if (schema.def.checks?.length) return undefined;
    const inner = leaf(schema.def.innerType);
    return inner && ((value) => value === null || inner(value));
  }
  if (schema instanceof z.ZodString) return stringCheck(schema.def.checks ?? []);
  if (schema instanceof z.ZodNumber) return numberCheck(schema.def.checks ?? []);
  if (schema instanceof z.ZodBoolean)
    return schema.def.checks?.length ? undefined : (value) => typeof value === "boolean";
  if (schema instanceof z.ZodLiteral) {
    if (schema.def.checks?.length) return undefined;
    const values = new Set<unknown>(schema.def.values);
    return (value) => values.has(value);
  }
  if (schema instanceof z.ZodEnum) {
    if (schema.def.checks?.length) return undefined;
    const values = new Set<unknown>(Object.values(schema.def.entries));
    return (value) => values.has(value);
  }
  return undefined;
}

function stringCheck(checks: z.core.$ZodCheck[]): Check | undefined {
  let min = 0;
  let max = Infinity;
  for (const check of checks) {
    if (check instanceof z.core.$ZodCheckMinLength) min = Math.max(min, defOf(check).minimum);
    else if (check instanceof z.core.$ZodCheckMaxLength) max = Math.min(max, defOf(check).maximum);
    else return undefined;
  }
  return (value) => typeof value === "string" && value.length >= min && value.length <= max;
}

function numberCheck(checks: z.core.$ZodCheck[]): Check | undefined {
  const parts: Check[] = [];
  for (const check of checks) {
    if (check instanceof z.core.$ZodCheckNumberFormat) {
      if (defOf(check).format !== "safeint") return undefined;
      parts.push((value) => Number.isSafeInteger(value));
    } else if (check instanceof z.core.$ZodCheckGreaterThan) {
      const { value: bound, inclusive } = defOf(check);
      if (typeof bound !== "number") return undefined;
      parts.push(inclusive ? (value) => Number(value) >= bound : (value) => Number(value) > bound);
    } else if (check instanceof z.core.$ZodCheckLessThan) {
      const { value: bound, inclusive } = defOf(check);
      if (typeof bound !== "number") return undefined;
      parts.push(inclusive ? (value) => Number(value) <= bound : (value) => Number(value) < bound);
    } else return undefined;
  }
  return (value) =>
    typeof value === "number" && Number.isFinite(value) && parts.every((part) => part(value));
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
