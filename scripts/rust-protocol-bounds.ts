// SPDX-License-Identifier: Apache-2.0

/*
 * Zod's constraint checks, read into the values the shape table's `StrBounds` and `NumBounds`
 * carry. Zod 4 keeps each check's data on `check._zod.def`; `kind` is its name, and the fields
 * below are the ones that change what a value must be. Checks that only refine (`.refine`,
 * `.superRefine`) are not here: no table can express their functions, so `ace-wire` states
 * them by hand in `refine.rs`.
 */

import type { z } from "zod";

/** A check's data, as Zod 4 stores it. */
export interface CheckDef {
  check?: unknown;
  format?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  value?: unknown;
  inclusive?: unknown;
  pattern?: unknown;
  when?: unknown;
}

export interface StrBounds {
  min?: number;
  max?: number;
  pattern?: string;
  format?: string;
  trim?: boolean;
}

export interface NumBounds {
  min?: number;
  minInclusive?: boolean;
  max?: number;
  maxInclusive?: boolean;
  integral?: boolean;
}

/** The checks on one schema's def. */
export function checksOf(def: Record<string, unknown>): CheckDef[] {
  const checks = def.checks;
  if (!Array.isArray(checks)) return [];
  return checks.map(
    (check) => ((check as Record<string, { def?: CheckDef }>)["_zod"]?.def ?? {}) as CheckDef,
  );
}

/** A string's bounds, or a refusal naming the check the table can't express. */
export function strBounds(def: Record<string, unknown>, path: string): StrBounds {
  if (def.coerce === true) throw new Error(`${path}: coercion changes the value`);
  const bounds: StrBounds = {};
  if (typeof def.format === "string") bounds.format = def.format;
  for (const check of checksOf(def)) {
    switch (check.check) {
      case "min_length":
        bounds.min = Number(check.minimum);
        break;
      case "max_length":
        bounds.max = Number(check.maximum);
        break;
      case "string_format":
        if (check.format === "regex" && check.pattern instanceof RegExp)
          bounds.pattern = check.pattern.source;
        else if (typeof check.format === "string") bounds.format = check.format;
        else throw new Error(`${path}: a string format the table can't express`);
        break;
      case "overwrite":
        bounds.trim = true;
        break;
      case "custom":
        // `.refine()`: a hand-written check in `ace-wire/src/refine.rs`.
        break;
      default:
        throw new Error(`${path}: a string check the table can't express (${String(check.check)})`);
    }
  }
  return bounds;
}

/** A number's bounds, or a refusal naming the check the table can't express. */
export function numBounds(def: Record<string, unknown>, path: string): NumBounds {
  if (def.coerce === true) throw new Error(`${path}: coercion changes the value`);
  const bounds: NumBounds = {};
  if (def.type === "int") bounds.integral = true;
  for (const check of checksOf(def)) {
    switch (check.check) {
      case "number_format":
        if (check.format === "safeint" || check.format === "int") bounds.integral = true;
        else throw new Error(`${path}: a number format the table can't express`);
        break;
      case "greater_than":
        bounds.min = Number(check.value);
        bounds.minInclusive = check.inclusive === true;
        break;
      case "less_than":
        bounds.max = Number(check.value);
        bounds.maxInclusive = check.inclusive === true;
        break;
      case "custom":
        break;
      default:
        throw new Error(`${path}: a number check the table can't express (${String(check.check)})`);
    }
  }
  return bounds;
}

/** An array's or tuple's length bounds from its checks. */
export function lengthBounds(
  def: Record<string, unknown>,
  path: string,
): { min?: number; max?: number } {
  const bounds: { min?: number; max?: number } = {};
  for (const check of checksOf(def)) {
    if (check.check === "min_length") bounds.min = Number(check.minimum);
    else if (check.check === "max_length") bounds.max = Number(check.maximum);
    else if (check.check === "custom") continue;
    else
      throw new Error(`${path}: an array check the table can't express (${String(check.check)})`);
  }
  return bounds;
}

/** A `.catch()`'s fallback, as JSON text. */
export function catchFallback(schema: z.ZodType, path: string): string {
  const def = (schema as unknown as { def: Record<string, unknown> }).def;
  const fallback = def.catchValue;
  if (typeof fallback !== "function") throw new Error(`${path}: a catch has no fallback value`);
  const value = (fallback as () => unknown)();
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error(`${path}: a catch's fallback is not JSON`);
  return text;
}
