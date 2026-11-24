/**
 * Shared keyboard arithmetic for the model pickers: which row a ⌘1…⌘9 key picks, and which rail
 * tab Arrow, Home or End moves to. Both pickers pass the rows and tabs they actually offer, so
 * a key never lands on something the person can't choose.
 */
export function numberedChoice<T>(rows: readonly T[], key: string): T | undefined {
  if (!/^[1-9]$/.test(key)) return undefined;
  return rows[Number(key) - 1];
}

/** The rail tab ArrowDown, ArrowUp, Home or End moves to from `current`, if any. */
export function railChoice<T extends { id: string }>(
  entries: readonly T[],
  current: string | null | undefined,
  key: string,
): T | undefined {
  if (!entries.length || current === undefined) return undefined;
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return undefined;
  const at = Math.max(
    0,
    entries.findIndex((entry) => entry.id === current),
  );
  const index =
    key === "Home"
      ? 0
      : key === "End"
        ? entries.length - 1
        : (at + (key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
  return entries[index];
}
