export const Layout = {
  pagePadding: 20,
  sectionGap: 24,
  cardPadding: 16,
  rowHeight: 64,
  compactRowHeight: 56,
  pillHeight: 34,
  tabBarHeight: 72,
} as const;

export const Radius = {
  panel: 24,
  card: 16,
  row: 14,
  pill: 999,
  input: 14,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
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
