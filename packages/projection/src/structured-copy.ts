/** Copy protocol JSON on native JS engines as well as browsers and Node. */
export function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
