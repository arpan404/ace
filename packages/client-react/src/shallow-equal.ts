/**
 * Whether two objects hold the same values under the same keys (`Object.is` per value). Its own
 * module, exported from `./thread-field.ts`, so the page's first chunk doesn't carry it.
 */
export function shallowEqual<T extends object>(a: T | undefined, b: T | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys)
    if (!Object.hasOwn(b, key) || !Object.is(a[key as keyof T], b[key as keyof T])) return false;
  return true;
}
