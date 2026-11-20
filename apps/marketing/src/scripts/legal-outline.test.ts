import { expect, test } from "vitest";
import { anchorId, anchorIds, currentSection } from "./legal-outline.ts";

test("a heading becomes a readable anchor without punctuation", () => {
  expect(anchorId("The short version")).toBe("the-short-version");
  expect(anchorId("Children's privacy, and changes!")).toBe("children-s-privacy-and-changes");
  expect(anchorId("  Who processes it?  ")).toBe("who-processes-it");
});

test("a heading with no letters or numbers still gets an id", () => {
  expect(anchorId("…")).toBe("section");
});

test("headings that repeat get distinct anchors, so every link lands on its own section", () => {
  expect(anchorIds(["Contact", "Changes", "Contact", "Contact"])).toEqual([
    "contact",
    "changes",
    "contact-2",
    "contact-3",
  ]);
});

test("the current section is the last one whose top has passed the reading line", () => {
  const tops = [-400, -20, 90, 700];
  expect(currentSection(tops, 100)).toBe(2);
  expect(currentSection(tops, 0)).toBe(1);
});

test("no section is current while the reader is above the first", () => {
  expect(currentSection([200, 900], 100)).toBe(-1);
  expect(currentSection([], 100)).toBe(-1);
});
