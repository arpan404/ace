/** What a lease secret reads as once redacted. */
export const leaseRedaction = "[ace lease redacted]";

type Container = unknown[] | Record<string, unknown>;
interface Open {
  value: Container;
  /** An object's own keys; an array walks by index. */
  keys: string[] | undefined;
  index: number;
  /** Redacted children by position, allocated only once one changes. */
  changed: Map<number, unknown> | undefined;
}
const isContainer = (value: unknown): value is Container =>
  value !== null && typeof value === "object";

const open = (value: Container): Open => ({
  value,
  keys: Array.isArray(value) ? undefined : Object.keys(value),
  index: 0,
  changed: undefined,
});
const childAt = (node: Open): unknown =>
  Array.isArray(node.value)
    ? node.value[node.index]
    : (node.value as Record<string, unknown>)[node.keys?.[node.index] ?? ""];

const record = (node: Open, value: unknown) => {
  if (value !== childAt(node)) (node.changed ??= new Map()).set(node.index, value);
  node.index++;
};

/**
 * Redact exact ephemeral lease material, retaining unchanged values without copying. The walk
 * is iterative, so nesting of any depth keeps every value that holds no secret.
 */
export function redactLease(data: unknown, secrets: readonly string[]): unknown {
  const active = secrets.filter((secret) => secret.length > 0);
  if (!active.length) return data;
  const text = (value: string) => {
    let result = value;
    for (const secret of active)
      if (result.includes(secret)) result = result.split(secret).join(leaseRedaction);
    return result;
  };
  const leaf = (value: unknown) => (typeof value === "string" ? text(value) : value);
  if (!isContainer(data)) return leaf(data);
  const stack = [open(data)];
  let result: unknown = data;
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (!top) break;
    const length = top.keys ? top.keys.length : (top.value as unknown[]).length;
    if (top.index < length) {
      const child = childAt(top);
      if (isContainer(child)) stack.push(open(child));
      else record(top, leaf(child));
      continue;
    }
    stack.pop();
    const done = finish(top, text);
    const parent = stack[stack.length - 1];
    if (parent) record(parent, done);
    else result = done;
  }
  return result;
}

function finish(node: Open, text: (value: string) => string): unknown {
  const { value, keys, changed } = node;
  if (!keys) {
    if (!changed || !Array.isArray(value)) return value;
    const copy = [...value];
    for (const [index, child] of changed) copy[index] = child;
    return copy;
  }
  const safeKeys = keys.map(text);
  if (!changed && safeKeys.every((key, index) => key === keys[index])) return value;
  const source = value as Record<string, unknown>;
  // Reserve original keys so redacted keys cannot overwrite an existing field.
  const used = new Set(keys);
  const suffixes = new Map<string, number>();
  const copy: Record<string, unknown> = {};
  keys.forEach((key, index) => {
    const safeKey = safeKeys[index] ?? key;
    let target = safeKey;
    if (safeKey !== key) {
      let suffix = suffixes.get(safeKey) ?? 1;
      while (used.has(target)) target = `${safeKey}#${suffix++}`;
      suffixes.set(safeKey, suffix);
      used.add(target);
    }
    Object.defineProperty(copy, target, {
      value: changed?.has(index) ? changed.get(index) : source[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });
  return copy;
}

/**
 * A frame's JSON with lease secrets redacted. The frame is serialized once; only a frame whose
 * text holds a secret is walked. A secret JSON would escape is always walked for.
 */
export function redactedFrameJson(
  data: unknown,
  secrets: readonly string[],
): { json: string; value: unknown } {
  const json = JSON.stringify(data);
  const clean = secrets.every((secret) => {
    if (!secret) return true;
    const escaped = JSON.stringify(secret).slice(1, -1);
    return escaped === secret && !json.includes(secret);
  });
  if (clean) return { json, value: data };
  const value = redactLease(data, secrets);
  return { json: JSON.stringify(value), value };
}
