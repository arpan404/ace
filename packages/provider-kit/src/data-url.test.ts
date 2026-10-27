import { expect, test } from "vitest";
import { base64DataUrl, isBase64 } from "./data-url.ts";

test("a multi-megabyte screenshot data URL yields its media type and its exact base64 bytes", () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 10)) % 256;
  const encoded = bytes.toString("base64");
  const image = base64DataUrl(`data:image/png;base64,${encoded}`);
  expect(image?.mimeType).toBe("image/png");
  expect(image?.data === encoded).toBe(true);
  expect(isBase64(image?.data ?? "")).toBe(true);
});

test("data URLs that are not plain base64 with one media type are refused", () => {
  expect(base64DataUrl("https://example.com/a.png")).toBeUndefined();
  expect(base64DataUrl("data:image/png,rawbytes")).toBeUndefined();
  expect(base64DataUrl("data:;base64,AAAA")).toBeUndefined();
  expect(base64DataUrl("data:image/png;name=a.png;base64,AAAA")).toBeUndefined();
  expect(base64DataUrl("data:image/png;base64,")).toEqual({ mimeType: "image/png", data: "" });
});

test("base64 text allows at most two trailing pad characters and nothing outside the alphabet", () => {
  expect(isBase64("QUJD")).toBe(true);
  expect(isBase64("QUI=")).toBe(true);
  expect(isBase64("QQ==")).toBe(true);
  expect(isBase64("Q===")).toBe(false);
  expect(isBase64("QU=I")).toBe(false);
  expect(isBase64("QU I")).toBe(false);
  expect(isBase64("QU-_")).toBe(false);
  expect(isBase64("==")).toBe(false);
  expect(isBase64("")).toBe(false);
});
