import { expect, test } from "vitest";
import { highlightLanguage } from "./checkout-marks.ts";

/*
 * The language the phone colours a file in: the shared highlighter's name where it has one,
 * otherwise the file's own extension for markit to read, and nothing for a file without one.
 */

test("a file the shared highlighter names keeps that language", () => {
  expect(highlightLanguage("apps/web/main.tsx")).toBe("tsx");
  expect(highlightLanguage("crates/markit/src/lib.rs")).toBe("rust");
  expect(highlightLanguage(".github/workflows/ios.yml")).toBe("yaml");
  expect(highlightLanguage("docs/README.MD")).toBe("markdown");
});

test("a file the shared highlighter doesn't name is coloured by its extension", () => {
  expect(highlightLanguage("examples/query.JSONL")).toBe("jsonl");
});

test("a file without an extension shows plain", () => {
  expect(highlightLanguage("Makefile")).toBeUndefined();
  expect(highlightLanguage(".gitignore")).toBeUndefined();
  expect(highlightLanguage("notes.")).toBeUndefined();
});
