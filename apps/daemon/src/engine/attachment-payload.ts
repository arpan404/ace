/** Native JSON can contain deeply nested future fields. Traverse without a call-stack limit. */
export function attachmentPayload(
  value: unknown,
  replace: (key: string, value: string) => string,
): unknown {
  let result: unknown;
  const pending: { value: unknown; key: string; assign(value: unknown): void }[] = [
    {
      value,
      key: "",
      assign: (copy) => {
        result = copy;
      },
    },
  ];
  while (pending.length) {
    const task = pending.pop();
    if (!task) break;
    const source = task.value;
    if (typeof source === "string") task.assign(replace(task.key, source));
    else if (Array.isArray(source)) {
      const copy: unknown[] = [];
      copy.length = source.length;
      task.assign(copy);
      source.forEach((entry: unknown, index: number) =>
        pending.push({
          value: entry,
          key: "",
          assign: (next) => {
            copy[index] = next;
          },
        }),
      );
    } else if (source !== null && typeof source === "object") {
      // fromEntries defines __proto__ as an ordinary own JSON field.
      const entries: [string, unknown][] = Object.entries(source);
      const copy: Record<string, unknown> = Object.fromEntries(entries);
      task.assign(copy);
      for (const [key, entry] of entries)
        pending.push({
          value: entry,
          key,
          assign: (next) => {
            Object.defineProperty(copy, key, {
              value: next,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          },
        });
    } else task.assign(source);
  }
  return result;
}
