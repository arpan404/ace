export const Layout = {
  pagePadding: 22,
  sectionGap: 28,
  cardPadding: 20,
  rowHeight: 76,
  pillHeight: 38,
  tabBarHeight: 86,
} as const;

export const Radius = {
  panel: 28,
  card: 24,
  row: 22,
  pill: 999,
  input: 20,
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
