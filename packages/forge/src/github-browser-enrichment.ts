import { z } from "zod";
import type { ForgePrRow } from "@ace/protocol/forge-browser";
import type { ForgeRepository } from "@ace/protocol/forge";
import { ForgeError } from "./errors.ts";

const total = z.looseObject({ totalCount: z.number().int().nonnegative() });
export const PrIndicator = z.looseObject({
  comments: total,
  reviews: total,
  statusCheckRollup: z.looseObject({ state: z.string() }).nullable(),
});
const Indicators = z.looseObject({
  data: z.looseObject({ repository: z.record(z.string(), PrIndicator.nullable()).optional() }),
});
export function prIndicatorFields(repository: ForgeRepository, numbers: readonly number[]): string {
  if (!numbers.length) return "";
  const fields = numbers.map(
    (number, i) =>
      `p${i}: pullRequest(number:${number}) { comments { totalCount } reviews { totalCount } statusCheckRollup { state } }`,
  );
  return `repository(owner:${JSON.stringify(repository.owner)}, name:${JSON.stringify(repository.name)}) { ${fields.join(" ")} }`;
}
/** A PR's comment and review counts and its checks' state, from its GraphQL fields. */
export function prIndicator(row: z.infer<typeof PrIndicator>): Partial<ForgePrRow> {
  const state = row.statusCheckRollup?.state;
  return {
    raw: row,
    commentCount: row.comments.totalCount,
    reviewCount: row.reviews.totalCount,
    ci:
      row.statusCheckRollup === null
        ? "none"
        : state === "SUCCESS"
          ? "success"
          : state === "FAILURE" || state === "ERROR"
            ? "failure"
            : state === "PENDING" || state === "EXPECTED"
              ? "pending"
              : "unknown",
  };
}
export function prIndicators(body: unknown): Record<string, Partial<ForgePrRow>> {
  const parsed = Indicators.safeParse(body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  const rows = parsed.data.data.repository ?? {};
  return Object.fromEntries(
    Object.entries(rows).flatMap(([key, row]) => (row ? [[key, prIndicator(row)]] : [])),
  );
}
