// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

/**
 * Cover each distinct string bound in the generated table using Zod's string
 * check in isolation. Regexes that require ASCII cannot take emoji at the
 * boundary. Store string recipes so the 44 MiB file-data bound stays small.
 */
export function stringBoundCases(table: object) {
  const bounds = new Map<
    string,
    | { check: "min_length"; minimum: number }
    | {
        check: "max_length";
        maximum: number;
      }
  >();
  function collect(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    if (
      "type" in value &&
      value.type === "string" &&
      "checks" in value &&
      Array.isArray(value.checks)
    ) {
      for (const rule of value.checks as unknown[]) {
        if (rule === null || typeof rule !== "object" || !("check" in rule)) continue;
        if (rule.check === "min_length" && "minimum" in rule && typeof rule.minimum === "number")
          bounds.set(`min/${rule.minimum}`, { check: rule.check, minimum: rule.minimum });
        if (rule.check === "max_length" && "maximum" in rule && typeof rule.maximum === "number")
          bounds.set(`max/${rule.maximum}`, { check: rule.check, maximum: rule.maximum });
      }
    }
    for (const child of Object.values(value)) collect(child);
  }
  collect(table);
  return [...bounds].flatMap(([name, rule]) => {
    const [schema, lengths] =
      rule.check === "min_length"
        ? [z.string().min(rule.minimum), [rule.minimum - 1, rule.minimum]]
        : [z.string().max(rule.maximum), [rule.maximum, rule.maximum + 1]];
    return lengths.map((length) => {
      const text = length === 0 ? "" : `${"a".repeat(length - 1)}🌱`;
      return { name: `${name}/${length}`, rule, length, accepted: schema.safeParse(text).success };
    });
  });
}
