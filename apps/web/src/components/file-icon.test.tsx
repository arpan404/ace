import { FileCssIcon, FileIcon, RocketIcon } from "@phosphor-icons/react";
import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { fileIcon, knownFileIcon } from "./file-icon.ts";
import { Icon, type IconGlyph } from "./icon.tsx";
import { projectGlyph } from "./project-glyphs.ts";

const drawing = (glyph: IconGlyph, props: { weight?: "regular" | "fill" | "bold" } = {}) =>
  render(<Icon icon={glyph} size={16} {...props} />).container.innerHTML;

test("a file's mark is drawn in the regular weight, even where the row asks for another", () => {
  const css = fileIcon("styles/app.css");
  expect(drawing(css)).toBe(drawing(FileCssIcon));
  expect(drawing(css, { weight: "fill" })).toBe(drawing(FileCssIcon));
  expect(drawing(css, { weight: "bold" })).toBe(drawing(FileCssIcon));
});

test("a file of a type with no mark of its own gets the plain file, and no known mark", () => {
  expect(drawing(fileIcon("notes.unknown"))).toBe(drawing(FileIcon));
  expect(knownFileIcon("notes.unknown")).toBeUndefined();
  expect(knownFileIcon("README")).toBeUndefined();
});

test("a project's glyph is bold in its mark and regular anywhere else", () => {
  const rocket = projectGlyph("rocket")?.icon;
  if (!rocket) throw new Error("No rocket glyph");
  expect(drawing(rocket, { weight: "bold" })).toBe(drawing(RocketIcon, { weight: "bold" }));
  expect(drawing(rocket)).toBe(drawing(RocketIcon));
  expect(drawing(rocket, { weight: "fill" })).toBe(drawing(RocketIcon));
});
