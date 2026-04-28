export interface ThreadBoardLayoutOption {
  columns: number;
  label: string;
  rows: number;
  value: string;
}

export function buildThreadBoardLayoutOptions(paneCount: number): ThreadBoardLayoutOption[] {
  if (paneCount <= 1) {
    return [];
  }

  const columns = new Set<number>();
  for (let columnCount = 1; columnCount <= Math.min(4, paneCount); columnCount += 1) {
    columns.add(columnCount);
  }
  columns.add(paneCount);

  return [...columns].map((columnCount) => {
    const rows = Math.ceil(paneCount / columnCount);
    return {
      columns: columnCount,
      label: `${columnCount} x ${rows}`,
      rows,
      value: String(columnCount),
    };
  });
}

export function getCurrentLayoutColumns(rows: readonly { paneIds: readonly string[] }[]): number {
  return rows.reduce((max, row) => Math.max(max, row.paneIds.length), 1);
}
