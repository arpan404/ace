import sharp from "sharp";
import { expect, test } from "vitest";
import { pdfArt, svgDocument } from "./pdf-svg.ts";
import { tinyPdf } from "./testing/tiny-pdf.ts";

/** The art drawn at one pixel per PDF unit, as RGBA pixels. */
async function pixels(bytes: Uint8Array) {
  const art = pdfArt(bytes);
  if (!art) throw new Error("no art");
  const { data, info } = await sharp(Buffer.from(svgDocument(art)))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    art,
    at(x: number, y: number) {
      const index = (y * info.width + x) * 4;
      return [...data.subarray(index, index + 4)];
    },
  };
}

test("a filled shape lands where the PDF puts it, with the page's y axis turned to point down", async () => {
  // A red bar along the bottom of a 100 × 50 page (PDF y counts up from the bottom).
  const { art, at } = await pixels(tinyPdf(100, 50, "1 0 0 rg 0 0 100 10 re f"));
  expect([art.width, art.height]).toEqual([100, 50]);
  expect(at(50, 45)).toEqual([255, 0, 0, 255]);
  expect(at(50, 5)[3]).toBe(0);
});

test("an even-odd clip cuts a hole, as Apple's bezels cut the screen out of the body", async () => {
  const ring = "0 0 100 100 re 25 25 50 50 re W* n 0 0 0 rg 0 0 100 100 re f";
  const { at } = await pixels(tinyPdf(100, 100, ring));
  expect(at(10, 10)).toEqual([0, 0, 0, 255]);
  expect(at(50, 50)[3]).toBe(0);
});

test("a clip ends with the graphics state it was set in", async () => {
  const drawing = "q 0 0 10 10 re W n Q 0 0 1 rg 0 0 100 100 re f";
  const { at } = await pixels(tinyPdf(100, 100, drawing));
  expect(at(80, 20)).toEqual([0, 0, 255, 255]);
});

test("transparency set through a graphics state carries into the fill", async () => {
  const { at } = await pixels(
    tinyPdf(20, 20, "/Half gs 0 0 0 rg 0 0 20 20 re f", { Half: "/Type /ExtGState /ca 0.5" }),
  );
  expect(at(10, 10)[3]).toBeGreaterThan(110);
  expect(at(10, 10)[3]).toBeLessThan(145);
});

test("a transform moves what is drawn after it", async () => {
  const { at } = await pixels(tinyPdf(100, 100, "1 0 0 1 50 0 cm 0 1 0 rg 0 0 10 100 re f"));
  expect(at(55, 50)).toEqual([0, 255, 0, 255]);
  expect(at(5, 50)[3]).toBe(0);
});

test("a page that draws nothing has no art, as an island iPhone's empty sensor bar", () => {
  expect(pdfArt(tinyPdf(393, 47, "q Q"))).toBeUndefined();
});

test("bytes that aren't a PDF have no art rather than throwing", () => {
  expect(pdfArt(new TextEncoder().encode("not a pdf"))).toBeUndefined();
});
