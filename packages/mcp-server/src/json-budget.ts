/** Bound traversal before schema cloning/JSON serialization. Escaping is checked exactly afterward. */
export function withinJsonBudget(value: unknown, limit: number): boolean {
  let remaining = limit;
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 32768 || depth > 64 || remaining < 0) return false;
    if (item === null) remaining -= 4;
    else if (typeof item === "string") {
      if (item.length > remaining) return false;
      remaining -= 2 + Buffer.byteLength(item);
    } else if (typeof item === "number") {
      if (!Number.isFinite(item)) return false;
      remaining -= String(item).length;
    } else if (typeof item === "boolean") remaining -= item ? 4 : 5;
    else if (Array.isArray(item)) {
      if (item.length > 32768) return false;
      remaining -= 2 + item.length;
      for (const child of item)
        if (!visit(child === undefined ? null : child, depth + 1)) return false;
    } else if (typeof item === "object") {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        return false;
      remaining -= 2;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (!visit(key, depth + 1)) return false;
        remaining -= 2;
        const child: unknown = Reflect.get(item, key);
        if (child !== undefined && !visit(child, depth + 1)) return false;
      }
    } else return false;
    return remaining >= 0;
  };
  return visit(value, 0);
}
export class ResultBudgetExceeded extends Error {}
