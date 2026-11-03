/*
 * Cases for the `ace/zod-schema-in-function` rule (scripts/oxlint/ace-plugin.js). A line ending in
 * `// flagged` must be reported and every other line must not. `scripts/check-zod-schemas.ts`
 * lints this file on every run and fails if the reports differ, which also proves the plugin
 * loaded. Never imported.
 */
import { z } from "zod";
import { z as schema, object as namedObject, type ZodType } from "zod";
import * as mini from "zod/mini";

// Module level: built once.
export const Row = z.object({ id: z.string() });
export const Wide = Row.extend({ name: z.string() });
export const Aliased = schema.object({ id: schema.number() });
export const Named = namedObject({ id: z.string() });
export const Mini = mini.object({ id: mini.string() });

export function perCall(value: unknown) {
  z.object({ id: z.string() }).parse(value); // flagged
  z.array(Row).parse(value); // flagged
  z.union([Row, Wide]).parse(value); // flagged
  schema.object({ id: schema.string() }).parse(value); // flagged
  namedObject({ id: z.string() }).parse(value); // flagged
  mini.object({ id: mini.string() }); // flagged
  Row.extend({ more: z.number() }).parse(value); // flagged
  Row.pick({ id: true }).parse(value); // flagged
  Later.partial().parse(value); // flagged
  Row.extend({ more: z.number() }).partial().parse(value); // flagged
  // A chain is reported once, at its builder.
  z.object({ id: z.string() }).extend({ more: z.number() }).parse(value); // flagged
  // Reusing module-level schemas builds nothing.
  Row.parse(value);
  Wide.safeParse(value);
  // Zod primitives and unrelated `.extend()`/`.pick()` are not object schemas.
  z.string().max(4).parse(value);
  return [lodashLike.pick(value), lodashLike.extend(value)];
}

export async function lazilyLoaded(value: unknown) {
  const { z: lazy } = await import("zod");
  return lazy.object({ id: lazy.string() }).parse(value); // flagged
}

export const perCallArrow = (value: unknown) => z.looseObject({}).parse(value); // flagged

export class PerCallMethod {
  read(value: unknown) {
    return z.strictObject({ id: z.string() }).parse(value); // flagged
  }
}

// Declared after the functions above that use it.
export const Later = z.object({ id: z.string() });

// Type-only uses build nothing.
export type RowType = ZodType<{ id: string }>;
const lodashLike = { pick: (value: unknown) => value, extend: (value: unknown) => value };
