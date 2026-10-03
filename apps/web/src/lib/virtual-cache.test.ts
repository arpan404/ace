import { renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { useForgetGoneRows } from "./virtual-cache.ts";

const keys = (start: number) => Array.from({ length: 50 }, (_, n) => `block-${start + n}`);

test("measured sizes of rows that left a sliding list are forgotten; rows still listed keep theirs", () => {
  const virtualizer = { itemSizeCache: new Map<unknown, number>() };
  const { rerender } = renderHook(
    ({ list }) => useForgetGoneRows(virtualizer, list.length, (index) => list[index]),
    { initialProps: { list: keys(0) } },
  );
  // A transcript streaming for hours: each change measures the new row; old rows slide out.
  for (let start = 1; start <= 5_000; start++) {
    const list = keys(start);
    for (const key of list)
      if (!virtualizer.itemSizeCache.has(key)) virtualizer.itemSizeCache.set(key, 96);
    rerender({ list });
  }
  expect(virtualizer.itemSizeCache.size).toBeLessThanOrEqual(50 * 2 + 64 + 1);
  for (const key of keys(5_000)) expect(virtualizer.itemSizeCache.get(key)).toBe(96);
});
