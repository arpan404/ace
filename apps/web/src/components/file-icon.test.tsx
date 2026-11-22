import { RocketIcon } from "@ace/icons";
import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { fileIcon, folderIcon, knownFileIcon } from "./file-icon.ts";
import { Icon, type IconGlyph } from "./icon.tsx";
import { projectGlyph } from "./project-glyphs.ts";

const drawing = (glyph: IconGlyph, props: { weight?: "regular" | "fill" | "bold" } = {}) =>
  render(<Icon icon={glyph} size={16} {...props} />).container.innerHTML;

test("a file is drawn in its type's tone, the same whatever weight the row asks for", () => {
  const css = fileIcon("styles/app.css");
  expect(drawing(css)).toContain("var(--file-blue)");
  expect(drawing(css, { weight: "fill" })).toBe(drawing(css));
  expect(drawing(css, { weight: "bold" })).toBe(drawing(css));
});

test("files of one type look alike wherever they live, and files of two types differ", () => {
  expect(drawing(fileIcon("a/one.rs"))).toBe(drawing(fileIcon("b/c/two.rs")));
  expect(drawing(fileIcon("one.rs"))).not.toBe(drawing(fileIcon("one.ts")));
  expect(drawing(fileIcon("one.ts"))).not.toBe(drawing(fileIcon("one.tsx")));
});

test("a file of no known type is the plain file in the row's ink, with no known mark", () => {
  expect(drawing(fileIcon("notes.unknown"))).not.toContain("var(--file-");
  expect(knownFileIcon("notes.unknown")).toBeUndefined();
  expect(knownFileIcon("README")).toBeDefined();
});

test("a marked folder keeps the row's ink and draws only its mark in its tone", () => {
  const src = drawing(folderIcon("packages/web/src"));
  expect(src).toContain("currentColor");
  expect(src).toContain("var(--file-blue)");
  expect(drawing(folderIcon("benches"))).not.toContain("var(--file-");
  expect(drawing(folderIcon("src", true))).not.toBe(src);
});

test("installed modules are dimmed", () => {
  expect(drawing(folderIcon("node_modules"))).toContain("opacity: 0.55");
  expect(drawing(folderIcon("src"))).not.toContain("opacity");
});

test("a project's glyph is bold in its mark and regular anywhere else", () => {
  const rocket = projectGlyph("rocket")?.icon;
  if (!rocket) throw new Error("No rocket glyph");
  expect(drawing(rocket, { weight: "bold" })).toBe(drawing(RocketIcon, { weight: "bold" }));
  expect(drawing(rocket)).toBe(drawing(RocketIcon));
  expect(drawing(rocket, { weight: "fill" })).toBe(drawing(RocketIcon));
});
