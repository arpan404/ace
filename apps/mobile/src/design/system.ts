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
  panel: 0,
  card: 0,
  row: 0,
  pill: 0,
  input: 0,
  xs: 0,
  sm: 0,
  md: 0,
  lg: 0,
  xl: 0,
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
