import { renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useListMotion } from "./motion.ts";

afterEach(() => vi.unstubAllGlobals());

const media = (reduced: boolean) => (query: string) =>
  ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as MediaQueryList;

const keyOf = (key: string) => key;

test("a row that moves up slides over the rows it passes, and only that row", () => {
  vi.stubGlobal("matchMedia", media(false));
  const { result, rerender } = renderHook(({ items }) => useListMotion(items, keyOf), {
    initialProps: { items: ["a", "b", "c", "d"] },
  });
  rerender({ items: ["a", "d", "b", "c"] });

  expect(result.current.moving).toBe(true);
  expect(result.current.rows.map((row) => row.key)).toEqual(["a", "d", "b", "c"]);
  expect(result.current.rows.filter((row) => row.rising).map((row) => row.key)).toEqual(["d"]);
});

test("with reduced motion a re-sort snaps: nothing slides and no row is raised", () => {
  vi.stubGlobal("matchMedia", media(true));
  const { result, rerender } = renderHook(({ items }) => useListMotion(items, keyOf), {
    initialProps: { items: ["a", "b", "c"] },
  });
  rerender({ items: ["c", "a", "b"] });

  expect(result.current.moving).toBe(false);
  expect(result.current.rows.map((row) => row.key)).toEqual(["c", "a", "b"]);
  expect(result.current.rows.some((row) => row.rising)).toBe(false);
});

const slide = (start: number) => Array.from({ length: 20 }, (_, n) => `row-${start + n}`);

test("a list that never settles keeps only the rows still fading out, not every row that left", () => {
  vi.stubGlobal("matchMedia", media(false));
  const { result, rerender } = renderHook(({ items }) => useListMotion(items, keyOf), {
    initialProps: { items: slide(0) },
  });
  // Like a streaming transcript: each change drops the oldest row and adds a new one, faster
  // than a fade-out takes, so the list never goes quiet.
  for (let step = 1; step <= 500; step++) rerender({ items: slide(step) });

  const leaving = result.current.rows.filter((row) => row.phase === "exit");
  expect(leaving.length).toBeLessThanOrEqual(12);
  expect(result.current.rows.filter((row) => row.phase !== "exit").map((row) => row.key)).toEqual(
    slide(500),
  );
});
