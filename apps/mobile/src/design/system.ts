export const Layout = {
  pagePadding: 18,
  sectionGap: 28,
  cardPadding: 18,
  rowHeight: 72,
  compactRowHeight: 56,
  pillHeight: 34,
  tabBarHeight: 64,
} as const;

export const Radius = {
  panel: 24,
  card: 16,
  row: 12,
  pill: 999,
  input: 10,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
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
