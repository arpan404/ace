import type { UsageQuery, UsageResult } from "@ace/protocol";
import type { AccountSummary } from "@ace/protocol/accounts";
import type { z } from "zod";

/** A combined provider reply stays within the same byte budget as its history rows. */
export function includeUsageAccounts(
  result: UsageResult,
  query: UsageQuery,
  accounts: z.infer<typeof AccountSummary>[],
): UsageResult {
  const included: z.infer<typeof AccountSummary>[] = [];
  let bytes = Buffer.byteLength(JSON.stringify(result)) + 32;
  for (const account of accounts) {
    if (query.filters.provider && !query.filters.provider.includes(account.provider)) continue;
    if (query.filters.account && !query.filters.account.includes(account.id)) continue;
    const size = Buffer.byteLength(JSON.stringify(account)) + 1;
    if (bytes + size > 512 * 1024) return { ...result, accounts: included, truncated: true };
    included.push(account);
    bytes += size;
  }
  return { ...result, accounts: included };
}
