export const Layout = {
  pagePadding: 20,
  sectionGap: 24,
  cardPadding: 16,
  rowHeight: 64,
  pillHeight: 36,
  tabBarHeight: 68,
} as const;

export const Radius = {
  panel: 20,
  card: 16,
  row: 14,
  pill: 999,
  input: 12,
} as const;

export function withAlpha(color: string, alpha: number): string {
  const normalized = color.replace("#", "");
  if (normalized.length !== 6) {
    return color;
  }

  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
