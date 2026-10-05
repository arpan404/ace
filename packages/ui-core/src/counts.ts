/** "1 needs you", "6 need you": the needs-you count in words, for names and headers alike. */
export function needYouPhrase(count: number): string {
  return `${count} ${count === 1 ? "needs" : "need"} you`;
}
