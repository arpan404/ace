import { BrowserAnnotation } from "@ace/protocol";
import { expect, test } from "vitest";
import { formatBrowserAnnotations, parseBrowserAnnotations, returnedAnnotations } from "./index.ts";

const element = (tag: string, text: string, selector: string) => ({
  tag,
  text,
  selector,
  xpath: `/html/body/${tag}`,
  box: { x: 0, y: 0, width: 10, height: 10 },
});

const region = (number: number, elements: ReturnType<typeof element>[]) =>
  BrowserAnnotation.parse({
    id: `r${number}`,
    kind: "region",
    number,
    documentId: "doc",
    url: "http://localhost:5173/pricing",
    title: "Pricing",
    point: { x: 0.5, y: 0.5 },
    comment: "Too cramped",
    element: element("section", "Plans Get started", "main > section.plans"),
    region: { box: { x: 120.4, y: 340, width: 480, height: 200.2 }, elements },
    viewport: { width: 1280, height: 720, devicePixelRatio: 2, scrollX: 0, scrollY: 200 },
  });

const every = { page: () => true, crop: () => true };

test("a region reads as its box and the elements inside it, with each element's selector", () => {
  const block = formatBrowserAnnotations(
    [
      region(3, [
        element("button", "Get started", "#start"),
        element("p", "Cancel any time", "p.note"),
      ]),
    ],
    every,
  );
  const text = block?.text ?? "";
  expect(text).toContain(
    '[3] Region 120,340 480×200 containing: <button> "Get started", <p> "Cancel any time"\n' +
      "Box: x=120 y=340 width=480 height=200 (CSS px from the document's top-left)\n" +
      "Inside: <section> main > section.plans\n" +
      'Elements:\n  <button> "Get started" at #start\n  <p> "Cancel any time" at p.note\n' +
      "Comment: Too cramped",
  );
  expect(text).toContain("A Region is an area the person dragged out");
  // The region's crop is promised like an element's.
  expect(block?.images).toContainEqual({ kind: "crop", id: "r3" });
});

test("a region's heading names its first four elements and says when there are more", () => {
  const many = ["a", "b", "c", "d", "e"].map((name) =>
    element("li", `Item ${name} with a long label that keeps going on`, `li.${name}`),
  );
  const text = formatBrowserAnnotations([region(1, many)], every)?.text ?? "";
  const heading = text.split("\n").find((line) => line.startsWith("[1] Region")) ?? "";
  expect(heading.match(/<li>/g)).toHaveLength(4);
  expect(heading.endsWith(", …")).toBe(true);
  expect(heading).toContain('"Item a with a long label that keeps goi…"');
  // The detail lines still name all five, with full excerpts.
  expect(text).toContain('  <li> "Item e with a long label that keeps going on" at li.e');
});

test("an empty region says only its box, and blocks without regions don't explain them", () => {
  const text = formatBrowserAnnotations([region(1, [])], every)?.text ?? "";
  expect(text).toContain("[1] Region 120,340 480×200\n");
  expect(text).not.toContain("Elements:");
  const plain = formatBrowserAnnotations(
    [BrowserAnnotation.parse({ ...region(2, []), kind: "element", region: undefined })],
    every,
  );
  expect(plain?.text).not.toContain("A Region is");
  expect(plain?.text).toContain('[2] <section> "Plans Get started"');
});

test("a sent region reads back with its box and elements, and Edit rebuilds it as a region", () => {
  const sent = region(1, [element("button", 'Say "hi" at once', "#start")]);
  const parsed = parseBrowserAnnotations(formatBrowserAnnotations([sent], every)?.text ?? "");
  expect(parsed?.items[0]).toMatchObject({
    kind: "region",
    number: 1,
    tag: "section",
    selector: "main > section.plans",
    box: { x: 120, y: 340, width: 480, height: 200 },
    comment: "Too cramped",
    elements: [{ tag: "button", text: 'Say "hi" at once', selector: "#start" }],
  });
  if (!parsed) throw new Error("unreadable block");
  const [item] = returnedAnnotations(parsed, []).annotations.items;
  expect(item?.annotation).toMatchObject({
    kind: "region",
    region: {
      box: { x: 120, y: 340, width: 480, height: 200 },
      elements: [{ tag: "button", selector: "#start" }],
    },
  });
});
