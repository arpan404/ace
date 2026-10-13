import { expect, test } from "vitest";
import { validateHtml } from "./index.ts";

test("preview accepts inline interactive pages and rejects network and navigation markup", () => {
  const interactive = validateHtml(
    '<!doctype html><html><body><input type="range" oninput="out.value=this.value"><output id="out"></output><script>document.title="ready"</script></body></html>',
  );
  expect(interactive).toMatchObject({ valid: true, diagnostics: [] });
  expect(validateHtml("<html><body><h1>Static diagram</h1></body></html>").diagnostics).toEqual([]);
  for (const markup of [
    '<script src="https://example.invalid/lib.js"></script>',
    '<iframe srcdoc="hello"></iframe>',
    '<meta http-equiv="refresh" content="0;url=https://example.invalid">',
    '<style>@import "https://example.invalid/style.css";</style>',
    '<a href="https://example.invalid">Leave</a>',
    '<img src="&#104;ttps://example.invalid/a.png">',
    '<link rel="preconnect" href="https://example.invalid">',
  ])
    expect(validateHtml(markup).valid).toBe(false);
});
test("size diagnostics count UTF-8 bytes before parsing", () => {
  const result = validateHtml("é".repeat(140000));
  expect(result.valid).toBe(false);
  expect(result.bytes).toBe(280000);
  expect(result.diagnostics.some((entry) => entry.code === "size")).toBe(true);
});

test("overly deep documents receive diagnostics instead of reaching recursive document serialization", () => {
  const result = validateHtml(
    `<html><body>${"<div>".repeat(80)}deep${"</div>".repeat(80)}</body></html>`,
  );
  expect(result.valid).toBe(false);
  expect(result.diagnostics.some((entry) => entry.code === "complexity")).toBe(true);
});
