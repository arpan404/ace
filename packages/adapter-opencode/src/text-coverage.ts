/** Longest prefix of buffered deltas present at the end of a full text snapshot.
 * Linear in snapshot bytes plus changed text, with no history scan per delta. */
export function coveredPrefix(snapshot: string, deltas: string): number {
  if (!deltas.length || !snapshot.length) return 0;
  const limit = Math.min(deltas.length, snapshot.length);
  const prefix = new Uint32Array(limit);
  for (let i = 1, matched = 0; i < limit; i++) {
    while (matched && deltas[i] !== deltas[matched]) matched = prefix[matched - 1] ?? 0;
    if (deltas[i] === deltas[matched]) matched++;
    prefix[i] = matched;
  }
  let matched = 0;
  for (let i = 0; i < snapshot.length; i++) {
    while (matched && (matched === limit || snapshot[i] !== deltas[matched]))
      matched = prefix[matched - 1] ?? 0;
    if (snapshot[i] === deltas[matched]) matched++;
  }
  return matched;
}
