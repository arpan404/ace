/** Subtract local calendar dates, rather than 24-hour spans across a DST transition. */
export function retainedDay(latestDay: string, days: number): string {
  return new Date(Date.parse(latestDay) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}
