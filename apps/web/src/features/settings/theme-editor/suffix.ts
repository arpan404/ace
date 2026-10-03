/** A short random suffix for new custom theme ids. Boundary code, so randomness lives here. */
export function newSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}
