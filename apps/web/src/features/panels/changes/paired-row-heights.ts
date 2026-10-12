/**
 * Thin DOM adapter for split panes: only mounted rows are measured, and only the row whose
 * content changed is resized. Measuring the inner content avoids a min-height feedback loop.
 */
export function createPairedRowHeights() {
  const rows = new Map<string, Set<HTMLDivElement>>();
  const keys = new WeakMap<HTMLDivElement, string>();
  const heights = new WeakMap<HTMLDivElement, number>();
  const align = (key: string) => {
    const pair = rows.get(key);
    if (!pair) return;
    let height = 20;
    for (const node of pair) height = Math.max(height, heights.get(node) ?? 0);
    for (const node of pair)
      if (node.parentElement) node.parentElement.style.minHeight = `${Math.ceil(height)}px`;
  };
  let observer: ResizeObserver | undefined;
  return {
    attach(key: string, node: HTMLDivElement | null) {
      if (!node) return;
      if (!observer && typeof ResizeObserver !== "undefined")
        observer = new ResizeObserver((entries) => {
          for (const entry of entries) {
            if (!(entry.target instanceof HTMLDivElement)) continue;
            const row = keys.get(entry.target);
            if (row === undefined) continue;
            heights.set(entry.target, entry.contentRect.height);
            align(row);
          }
        });
      const pair = rows.get(key) ?? new Set<HTMLDivElement>();
      rows.set(key, pair);
      pair.add(node);
      keys.set(node, key);
      heights.set(node, node.getBoundingClientRect().height);
      observer?.observe(node);
      align(key);
      return () => {
        observer?.unobserve(node);
        pair.delete(node);
        keys.delete(node);
        heights.delete(node);
        if (!pair.size) rows.delete(key);
        else align(key);
        if (!rows.size) observer?.disconnect();
      };
    },
  };
}
