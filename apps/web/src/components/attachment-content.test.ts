import { expect, it } from "vitest";
import { readsAsText } from "./attachment-content.ts";

const decoded = (bytes: number[]) => new TextDecoder().decode(new Uint8Array(bytes));

it("source and prose with tabs and newlines read as text", () => {
  expect(readsAsText("module example.com/x\n\ngo 1.24\n\trequire (\r\n)")).toBe(true);
  expect(readsAsText("Größe · 大小 · emoji 🎉")).toBe(true);
});

it("bytes with NULs or invalid UTF-8 read as binary", () => {
  expect(readsAsText(decoded([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0x00]))).toBe(false);
  expect(readsAsText(decoded([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe]))).toBe(false);
});
