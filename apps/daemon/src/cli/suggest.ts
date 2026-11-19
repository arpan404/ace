/**
 * The nearest word to a typo (ADR 0178 §4): `thraed` → `thread`. Pure. Optimal string
 * alignment distance, so one swapped pair of letters counts as one edit.
 */
export function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[] = Array.from({ length: rows * cols }, () => 0);
  const at = (i: number, j: number) => d[i * cols + j] ?? 0;
  for (let i = 0; i < rows; i++) d[i * cols] = i;
  for (let j = 0; j < cols; j++) d[j] = j;
  for (let i = 1; i < rows; i++)
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, at(i - 2, j - 2) + 1);
      d[i * cols + j] = best;
    }
  return at(a.length, b.length);
}

/** The closest candidate, or undefined when nothing is close enough to be a typo. */
export function nearest(word: string, candidates: Iterable<string>): string | undefined {
  const typed = word.toLowerCase();
  let best: { candidate: string; score: number } | undefined;
  for (const candidate of candidates) {
    if (!candidate || candidate.startsWith("__")) continue;
    const score =
      typed.length >= 3 && candidate.startsWith(typed) ? 0.5 : distance(typed, candidate);
    if (!best || score < best.score) best = { candidate, score };
  }
  if (!best) return undefined;
  const allowed = Math.max(1, Math.floor(Math.max(typed.length, best.candidate.length) / 3));
  return best.score <= allowed ? best.candidate : undefined;
}
