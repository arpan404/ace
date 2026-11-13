import { renderHook } from "@testing-library/react";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { staggerSpanMs, useListMotion } from "./motion.ts";

afterEach(() => vi.unstubAllGlobals());

const media = (reduced: boolean) => (query: string) =>
  ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as MediaQueryList;

const keyOf = (key: string) => key;
const rowOf = (key: string, unconfirmed: boolean) => ({ key, unconfirmed });

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
  // The theme provider marks <html> from the Reduce motion setting and the system preference.
  document.documentElement.setAttribute("data-reduce-motion", "");
  onTestFinished(() => document.documentElement.removeAttribute("data-reduce-motion"));
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

test("rows leaving together with a stagger go one after another, and a big fold still ends within the span", () => {
  vi.stubGlobal("matchMedia", media(false));
  const many = Array.from({ length: 30 }, (_, n) => `row-${n}`);
  const { result, rerender } = renderHook(
    ({ items }) => useListMotion(items, keyOf, { exitStagger: 40, bulkAt: Infinity }),
    { initialProps: { items: [...many, "kept"] } },
  );
  rerender({ items: ["kept"] });

  const delays = result.current.rows.filter((row) => row.phase === "exit").map((r) => r.delay);
  expect(delays).toHaveLength(30);
  expect(delays.every((delay, n) => n === 0 || delay > (delays[n - 1] ?? 0))).toBe(true);
  expect((delays.at(-1) ?? 0) + 140).toBeLessThanOrEqual(staggerSpanMs);
});

test("without a stagger, a change past the bulk limit shows at once", () => {
  vi.stubGlobal("matchMedia", media(false));
  const many = Array.from({ length: 30 }, (_, n) => `row-${n}`);
  const { result, rerender } = renderHook(({ items }) => useListMotion(items, keyOf), {
    initialProps: { items: [...many, "kept"] },
  });
  rerender({ items: ["kept"] });
  expect(result.current.rows.map((row) => row.key)).toEqual(["kept"]);
});

test("a change the list marks as a settle shows at once, with no row playing an exit", () => {
  vi.stubGlobal("matchMedia", media(false));
  const { result, rerender } = renderHook(
    ({ items }) =>
      useListMotion(items, (item) => item.key, {
        exitStagger: 40,
        snapWhen: (leaving) => leaving.some((item) => item.unconfirmed),
      }),
    { initialProps: { items: [rowOf("a", true), rowOf("b", true), rowOf("done", false)] } },
  );
  // The facts behind a and b became current: they fold into done, with nothing to fade.
  rerender({ items: [rowOf("done", false)] });
  expect(result.current.rows.map((item) => item.key)).toEqual(["done"]);
});
