import type { SuitDetail } from "@ace/protocol/suits";
import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { fakeSuit } from "@/test/fake-suits.ts";
import { useSuitFontsReady, type FontSource, type SuitFontLoader } from "./suit-fonts.ts";

const withFont = (id: string, url: string): SuitDetail => ({
  ...fakeSuit({
    id,
    dark: { canvas: "#101014" },
    fonts: { ui: { asset: "assets/pixel.woff2", family: "Pixel" } },
  }),
  assets: { "assets/pixel.woff2": url },
});

/** A loader whose loads finish when the test says. */
function heldLoader() {
  const asked: FontSource[][] = [];
  const finish: (() => void)[] = [];
  const loader: SuitFontLoader = {
    load(sources) {
      asked.push([...sources]);
      return new Promise((resolve) => finish.push(resolve));
    },
  };
  return { loader, asked, finishAll: () => act(() => finish.splice(0).forEach((done) => done())) };
}

test("switching to a Suit keeps the old look until the new Suit's fonts have loaded", async () => {
  const { loader, asked, finishAll } = heldLoader();
  const plain = fakeSuit({ id: "plain", dark: { canvas: "#000000" } });
  const pixel = withFont("pixel", "http://127.0.0.1:4242/v1/suits/pixel/h/g/assets/pixel.woff2");
  const { result, rerender } = renderHook(({ detail }) => useSuitFontsReady(detail, loader), {
    initialProps: { detail: plain as SuitDetail | null },
  });
  expect(result.current).toBe(plain);
  rerender({ detail: pixel });
  expect(result.current).toBe(plain);
  expect(asked).toEqual([
    [
      {
        family: "ace-suit-pixel-ui",
        url: "http://127.0.0.1:4242/v1/suits/pixel/h/g/assets/pixel.woff2",
        format: "woff2",
      },
    ],
  ]);
  await finishAll();
  expect(result.current).toBe(pixel);

  // Turning Suits off, and coming back to fonts already loaded, never waits.
  rerender({ detail: null });
  expect(result.current).toBeNull();
  rerender({ detail: pixel });
  expect(result.current).toBe(pixel);
  expect(asked).toHaveLength(1);
});

test("the Suit a page opens with shows at once; the boot record already painted it", () => {
  const { loader, asked } = heldLoader();
  const pixel = withFont("pixel", "http://127.0.0.1:4242/a.woff2");
  const { result } = renderHook(() => useSuitFontsReady(pixel, loader));
  expect(result.current).toBe(pixel);
  expect(asked).toEqual([]);
});

test("without a font loader (no FontFace) a Suit shows at once", () => {
  const plain = fakeSuit({ id: "plain", dark: { canvas: "#000000" } });
  const pixel = withFont("pixel", "http://127.0.0.1:4242/a.woff2");
  const { result, rerender } = renderHook(({ detail }) => useSuitFontsReady(detail, undefined), {
    initialProps: { detail: plain },
  });
  rerender({ detail: pixel });
  expect(result.current).toBe(pixel);
});

test("the same Suit at new URLs (a new daemon run) shows at once: its faces are already on the page", () => {
  const { loader, asked } = heldLoader();
  const before = withFont("pixel", "http://127.0.0.1:4242/v1/suits/pixel/h/grant-a/a.woff2");
  const after = withFont("pixel", "http://127.0.0.1:4242/v1/suits/pixel/h/grant-b/a.woff2");
  const { result, rerender } = renderHook(({ detail }) => useSuitFontsReady(detail, loader), {
    initialProps: { detail: before },
  });
  rerender({ detail: after });
  expect(result.current).toBe(after);
  expect(asked).toEqual([]);
});
