/** "1 needs you", "6 need you": the needs-you count in words, for names and headers alike. */
export function needYouPhrase(count: number): string {
  return `${count} ${count === 1 ? "needs" : "need"} you`;
}

const grouped = new Intl.NumberFormat("en-US");

/** Counts in lists read at a glance, with the same singular wording on every surface. */
export const formatCount = (n: number): string => grouped.format(n);
export const pluralCount = (n: number, one: string, many = `${one}s`) =>
  `${formatCount(n)} ${n === 1 ? one : many}`;
