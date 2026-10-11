import type { Item } from "@ace/protocol";

/** A provider's window warning, without repeating its account name or reset explanation. */
export function usageWarning(
  item: Item | undefined,
): { label: string; urgent: boolean } | undefined {
  if (item?.type !== "notice" || item.level !== "warning") return undefined;
  const match = /has used (\d+(?:\.\d+)?)% of its (\d+)-hour window/.exec(item.text);
  if (!match) return undefined;
  const percent = Number(match[1]);
  const hours = Number(match[2]);
  if (percent < 0 || percent > 100 || hours < 1) return undefined;
  return { label: `${percent}% of ${hours}-h limit`, urgent: percent > 90 };
}
