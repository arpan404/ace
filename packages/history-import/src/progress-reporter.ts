/** Intermediate inventories are bounded; the terminal inventory always reaches consumers. */
export function progressReporter<T>(now: () => number, send: (value: T) => void) {
  let last = -Infinity;
  return {
    update(value: T) {
      const time = now();
      if (time - last < 250) return;
      last = time;
      send(value);
    },
    finish(value: T) {
      send(value);
    },
  };
}
