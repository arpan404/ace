import { expect, test } from "vitest";
import { negotiateContentEncoding } from "./content-encoding.ts";

test("brotli wins whenever it is accepted, regardless of casing or spacing", () => {
  expect(negotiateContentEncoding("gzip, deflate, br")).toBe("br");
  expect(negotiateContentEncoding("GZip ; q=0.9 , BR ; q=0.8")).toBe("br");
  expect(negotiateContentEncoding("gzip")).toBe("gzip");
});

test("refused, malformed or missing codings fall back to identity", () => {
  expect(negotiateContentEncoding(undefined)).toBeUndefined();
  expect(negotiateContentEncoding("")).toBeUndefined();
  expect(negotiateContentEncoding("deflate")).toBeUndefined();
  expect(negotiateContentEncoding("br;q=0, gzip;q=0.000")).toBeUndefined();
  expect(negotiateContentEncoding("br;q=abc, gzip;q=0.5")).toBe("gzip");
  expect(negotiateContentEncoding("br;q=1.5")).toBeUndefined();
});

test("a wildcard covers only codings without their own entry", () => {
  expect(negotiateContentEncoding("*")).toBe("br");
  expect(negotiateContentEncoding("br;q=0, *")).toBe("gzip");
  expect(negotiateContentEncoding("gzip;q=0, *;q=0")).toBeUndefined();
});
