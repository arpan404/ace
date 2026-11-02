/** Thrown inside `JSON.stringify` to stop it once the budget is spent. */
class OverBudget extends Error {}

/**
 * `JSON.stringify` that gives up as soon as the text would pass `maxBytes`, so an oversized
 * value costs work in proportion to the limit, not to its own size. A page's accessibility
 * tree or an evaluated result can be gigabytes once serialized; building that whole string
 * on the main thread only to find it over a 1 MB relay limit froze the app.
 *
 * Undefined when the value is over the limit or cannot be serialized (a cycle, a BigInt, a
 * string past V8's length limit). The count during the walk never exceeds the text's real
 * size (strings count UTF-16 units before escaping), and the result is checked exactly.
 */
export function stringifyWithin(value: unknown, maxBytes: number): string | undefined {
  let budget = maxBytes;
  const spend = (bytes: number) => {
    budget -= bytes;
    if (budget < 0) throw new OverBudget();
  };
  let text: string | undefined;
  try {
    text = JSON.stringify(value, function count(this: unknown, key: string, entry: unknown) {
      // Never more than the text will hold: an array item adds a separator, an object entry
      // its quoted key and a colon unless JSON drops it; the root (key "") adds nothing. A
      // container's brackets go uncounted, which covers its one separator fewer than items.
      const dropped =
        entry === undefined || typeof entry === "function" || typeof entry === "symbol";
      if (Array.isArray(this)) spend(1);
      else if (key !== "" && !dropped) spend(key.length + 3);
      if (typeof entry === "string") spend(entry.length + 2);
      else if (typeof entry === "number") spend(String(entry).length);
      else if (typeof entry === "boolean" || entry === null) spend(4);
      return entry;
    });
  } catch {
    return undefined;
  }
  if (text === undefined || Buffer.byteLength(text) > maxBytes) return undefined;
  return text;
}
