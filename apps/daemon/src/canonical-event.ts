import { types } from "node:util";
import { Event } from "@ace/protocol";
import { z } from "zod";

/**
 * The writer's canonicalising step, without Zod's full parse where the schema shows it isn't
 * needed (ADR 0125, point 4). `Event.parse` checks an event and rebuilds it in this build's shape:
 * keys in schema order, unknown keys dropped, defaults filled. For a payload variant whose
 * fields are all flat (strings, numbers, booleans, literals and enums, optional or nullable,
 * with only length, integer and range checks) there is nothing to fill, so the same checks and
 * the same rebuild are done here directly, with one new object per level. The plans are read
 * off the schema once, at first use; a variant with anything else in it (a nested object, a
 * default, a transform, a refinement, a format, a check not listed below) has no plan and goes
 * to `Event.parse`. So does every input a plan rejects, which keeps Zod's error for it, and
 * every input that isn't plain data (a proxy, a getter, an inherited field).
 */
export function canonicalEvent(input: unknown): Event {
  built ??= canonicaliser(Event);
  return built.canonical(input);
}
let built: Canonicaliser<Event> | undefined;

/** The payload types canonicalised without `Event.parse`; tests read it to cover each one. */
export function plannedPayloadTypes(): ReadonlySet<string> {
  built ??= canonicaliser(Event);
  return built.planned;
}

export interface Canonicaliser<T> {
  /** What `schema.parse(input)` returns, or throws. */
  canonical(input: unknown): T;
  /** The payload discriminator values that have a plan. */
  planned: ReadonlySet<string>;
}

/**
 * The canonicaliser of an envelope schema: an object of flat fields whose last field, `payload`,
 * is a discriminated union. Any other envelope, and any variant the plans can't cover, falls
 * back to `schema.parse`; building the plans never throws for a shape it doesn't know.
 */
export function canonicaliser<T>(schema: z.ZodType<T>): Canonicaliser<T> {
  const fallback: Canonicaliser<T> = { canonical: (input) => schema.parse(input), planned: none };
  if (!(schema instanceof z.ZodObject) || !plainObject(schema)) return fallback;
  const { payload, ...envelopeShape } = schema.shape;
  // The rebuild puts `payload` last, where the shape must have it for the key order to match.
  if (Object.keys(schema.shape).at(-1) !== "payload") return fallback;
  if (!(payload instanceof z.ZodDiscriminatedUnion) || payload.def.checks?.length) return fallback;
  const envelope = flatObject(z.object(envelopeShape));
  if (!envelope) return fallback;
  const discriminator = payload.def.discriminator;
  const variants = new Map<unknown, Build>();
  for (const option of payload.options) {
    if (!(option instanceof z.ZodObject)) continue;
    const tag = option.shape[discriminator];
    // Only a literal discriminator names its variants; any other kind keeps Zod's routing.
    if (!(tag instanceof z.ZodLiteral)) continue;
    const build = flatObject(option);
    if (build) for (const value of tag.def.values) variants.set(value, build);
  }
  const planned = new Set([...variants.keys()].filter((key) => typeof key === "string"));
  return {
    planned,
    canonical(input) {
      const body = plainField(input, "payload");
      const build = body === absent ? undefined : variants.get(plainField(body, discriminator));
      const head = build && envelope(input);
      const rebuilt = head && build(body);
      if (!head || !rebuilt) return fallback.canonical(input);
      head.payload = rebuilt;
      // Trusted: every field passed the schema's own checks, rebuilt as schema.parse would.
      return head as T;
    },
  };
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
  /** Length bounds for a string (in code points, as Zod counts), value bounds for a number. */
  min: number;
  minInclusive: boolean;
  max: number;
  maxInclusive: boolean;
  integer: boolean;
  values: ReadonlySet<unknown>;
}
type Build = (input: unknown) => Record<string, unknown> | undefined;
const none: ReadonlySet<string> = new Set();
const noValues: ReadonlySet<unknown> = new Set();

function passes(field: Field, value: unknown): boolean {
  if (value === null) return field.nullable;
  switch (field.kind) {
    case "string":
      return typeof value === "string" && lengthWithin(value, field.min, field.max);
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

/**
 * Whether the string's code point count is within bounds. A code point is one or two UTF-16
 * units, so the count lies between half the length and the length; most strings are decided
 * by that alone, without counting.
 */
function lengthWithin(value: string, min: number, max: number): boolean {
  const units = value.length;
  if (units < min) return false;
  if (units <= max && (units + 1) >> 1 >= min) return true;
  const points = codePoints(value);
  return points >= min && points <= max;
}

/** Code points as the string iterator yields them: a lone surrogate counts as one. */
function codePoints(value: string): number {
  let pairs = 0;
  for (let at = 0; at < value.length - 1; at++) {
    const high = value.charCodeAt(at);
    if (high < 0xd800 || high > 0xdbff) continue;
    const low = value.charCodeAt(at + 1);
    if (low >= 0xdc00 && low <= 0xdfff) {
      pairs++;
      at++;
    }
  }
  return value.length - pairs;
}

/** Marks a field the input doesn't have (as distinct from one holding undefined). */
const absent = Symbol("absent");

/**
 * An own data field's value, read without running any of the input's code. Anything else that
 * could make two reads differ, or differ from what Zod reads (a proxy, a getter or setter, a
 * field inherited from a prototype, a non-object), answers `absent`, which no plan matches:
 * the caller then leaves the whole input to Zod.
 */
function plainField(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input) || types.isProxy(input))
    return absent;
  return dataField(input, key);
}

/**
 * As `plainField`, for an object known not to be a proxy. A getter is found, own or inherited,
 * without calling it and without allocating (a property descriptor costs 64 bytes a read); a
 * setter alone runs no code on a read, which gives undefined there as it does in Zod.
 */
function dataField(input: object, key: string): unknown {
  if (!Object.hasOwn(input, key)) return key in input ? absent : undefined;
  if (getterOf(input, key) !== undefined) return absent;
  return Reflect.get(input, key);
}

/** `Object.prototype.__lookupGetter__`, which TypeScript's library doesn't declare. */
const found: unknown = Reflect.get(Object.prototype, "__lookupGetter__");
const lookupGetter = typeof found === "function" ? found : undefined;
/** The getter reading `key` would run; without the lookup every field counts as one. */
function getterOf(input: object, key: string): unknown {
  // `call`, not `Reflect.apply`: an argument array per read would cost more than it saves.
  const getter: unknown = lookupGetter ? lookupGetter.call(input, key) : absent;
  return getter;
}

/** An object schema that strips unknown keys and runs no checks of its own. */
function plainObject(schema: z.ZodObject): boolean {
  return schema.def.catchall === undefined && !schema.def.checks?.length;
}

/** A flat object's plan: the checks of its fields, and the rebuild in schema order. */
function flatObject(schema: z.ZodObject): Build | undefined {
  if (!plainObject(schema)) return undefined;
  const fields: Field[] = [];
  for (const [key, field] of Object.entries(schema.shape)) {
    const plan = fieldPlan(key, field);
    if (!plan) return undefined;
    fields.push(plan);
  }
  return (input) => {
    // Plain data only: `dataField` below then reads each field once, running no input code.
    if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
    if (types.isProxy(input)) return undefined;
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const value = dataField(input, field.key);
      if (value === absent) return undefined;
      if (value === undefined && field.optional) {
        // Zod keeps an optional key that is present as undefined, and omits an absent one.
        if (Object.hasOwn(input, field.key)) out[field.key] = undefined;
        continue;
      }
      if (!passes(field, value)) return undefined;
      out[field.key] = value;
    }
    return out;
  };
}

/** A field's plan, or none when the schema has anything a plan can't reproduce. */
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
  // A schema that is itself a check (`z.int()`, `z.email()`) checks more than `def.checks` lists.
  if (at instanceof z.core.$ZodCheck || !(at instanceof z.ZodType)) return undefined;
  const checks = at.def.checks ?? [];
  const base = { key, optional, nullable, integer: false, values: noValues };
  const unbounded = { min: -Infinity, minInclusive: true, max: Infinity, maxInclusive: true };
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
  // Zod's resolved values: an enum built from a numeric TypeScript enum drops its reverse names.
  if (at instanceof z.ZodEnum)
    return { ...base, ...unbounded, kind: "one of", values: new Set<unknown>(at.options) };
  return undefined;
}

/** A check's definition: what it checks, with its bound. Zod keeps it only on `_zod`. */
function defOf<T extends { _zod: { def: unknown } }>(check: T): T["_zod"]["def"] {
  // oxlint-disable-next-line no-underscore-dangle -- Zod's own check definition.
  return check._zod.def;
}
