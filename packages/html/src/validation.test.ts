import { expect, test } from "vitest";
import { validateHtml } from "./index.ts";

test("self-contained interactive documents pass while network and navigation markup receives diagnostics", () => {
  expect(
    validateHtml(
      '<!doctype html><html><body><button onclick="this.textContent=42">Count</button></body></html>',
    ).valid,
  ).toBe(true);
  for (const markup of [
    '<script src="https://example.invalid/lib.js"></script>',
    '<iframe srcdoc="hello"></iframe>',
    '<meta http-equiv="refresh" content="0;url=https://example.invalid">',
    '<style>@import "https://example.invalid/style.css";</style>',
    '<a href="https://example.invalid">Leave</a>',
    '<img src="&#104;ttps://example.invalid/a.png">',
  ])
    expect(validateHtml(markup).valid).toBe(false);
});
test("size diagnostics count UTF-8 bytes before parsing", () => {
  const result = validateHtml("é".repeat(140000));
  expect(result.valid).toBe(false);
  expect(result.bytes).toBe(280000);
  expect(result.diagnostics.some((entry) => entry.code === "size")).toBe(true);
});
