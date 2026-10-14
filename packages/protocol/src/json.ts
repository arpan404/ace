import { z } from "zod";

/** Object members may be absent: optional fields serialize as JSON by being left out. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

/**
 * Any JSON value; it accepts what z.json() accepts. Its recursion goes through the declared
 * `JsonValue` type: TypeScript 7.1 reports z.json()'s own recursive record inference as
 * infinitely circular wherever it meets another object type, such as a catchall or a union of
 * wire messages.
 */
export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);
