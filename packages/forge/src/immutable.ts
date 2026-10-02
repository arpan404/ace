/** Immutable values are shared between resource revisions and public snapshots. */
export function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) immutable(entry);
  }
  return value;
}
