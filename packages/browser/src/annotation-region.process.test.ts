import { expect, it, vi } from "vitest";
import { BrowserAnnotationCapture } from "@ace/protocol";
import {
  annotationFixture,
  executablePath,
  isMarkerBlue,
  pixel,
} from "./annotation-test-support.ts";

const test = it.skipIf(!executablePath);

async function onRegionPage() {
  const f = await annotationFixture();
  const person = f.connect("person");
  await person.subscribe();
  await person.execute({ action: "navigate", url: `${f.origin}/region` });
  await person.execute({ action: "annotate", operation: "start", config: { theme: "light" } });
  await person.event("ready");
  return { f, person };
}

/** Drag out an area, comment on it and save: the region record the page reports. */
async function region(
  person: Awaited<ReturnType<typeof onRegionPage>>["person"],
  from: { x: number; y: number },
  to: { x: number; y: number },
  comment: string,
) {
  const before = person.events().length;
  await person.drag(from, to);
  await person.type(comment);
  await person.press("Enter");
  return (await person.event("saved", before)).annotation;
}

test("dragging out an area saves a region with its box and the elements inside, and the page sees none of it", async () => {
  const { person } = await onRegionPage();
  const annotation = await region(
    person,
    { x: 90, y: 90 },
    { x: 520, y: 320 },
    "Tighten this card",
  );
  expect(annotation).toMatchObject({
    kind: "region",
    number: 1,
    comment: "Tighten this card",
    region: { box: { x: 90, y: 90, width: 430, height: 230 } },
  });
  // The card is the only thing inside, so the agent is told about what the card holds.
  expect(annotation.region?.elements.map((element) => [element.tag, element.text])).toEqual([
    ["h2", "Plans"],
    ["button", "Get started"],
    ["p", "Cancel any time"],
  ]);
  expect(annotation.region?.elements.map((element) => element.selector)).toEqual([
    "#heading",
    "#start",
    "#copy",
  ]);
  expect(await person.evaluate("[pageClicks, pageDowns, buttonClicks]")).toEqual([0, 0, 0]);
  expect(await person.evaluate("getSelection().toString()")).toBe("");
}, 60_000);

test("a press that moves less than the drag threshold still pins the element under it", async () => {
  const { person } = await onRegionPage();
  const box = await person.box("#copy");
  const x = box.x + 20;
  const y = box.y + box.height / 2;
  const before = person.events().length;
  await person.move(x, y, "none");
  await person.mouse("mousePressed", x, y);
  await person.move(x + 2, y + 1, "left");
  await person.mouse("mouseReleased", x + 2, y + 1);
  await person.type("Shorter copy");
  await person.press("Enter");
  const annotation = (await person.event("saved", before)).annotation;
  expect(annotation).toMatchObject({ kind: "element", element: { tag: "p", selector: "#copy" } });
  expect(annotation.region).toBeUndefined();
}, 60_000);

test("holding Space hands pointer input to the page, and releasing it resumes annotating", async () => {
  const { f, person } = await onRegionPage();
  const button = await person.box("#start");
  await person.key("keyDown", " ", "Space");
  await person.click(button.x + 20, button.y + 10);
  await vi.waitFor(async () => expect(await person.evaluate("buttonClicks")).toBe(1), {
    timeout: 5_000,
  });
  // Space held for the page never scrolled it either.
  expect(await person.evaluate("scrollY")).toBe(0);
  await person.key("keyUp", " ", "Space");
  // Nothing was pinned while Space was down; the first pin after it is number 1.
  const annotation = await f.pin(person, "#copy", "After the hold");
  expect(annotation).toMatchObject({ number: 1, kind: "element", comment: "After the hold" });
  expect(person.events().filter((event) => event.kind === "saved")).toHaveLength(1);
  expect(await person.evaluate("buttonClicks")).toBe(1);
}, 60_000);

test("a region's crop is exactly the region", async () => {
  const { person } = await onRegionPage();
  const annotation = await region(person, { x: 60, y: 80 }, { x: 260, y: 200 }, "This corner");
  const ratio = Number(await person.evaluate("devicePixelRatio"));
  const crop = BrowserAnnotationCapture.parse(
    await person.execute({
      action: "annotate_capture",
      target: { kind: "annotation", id: annotation.id },
    }),
  );
  expect(Math.abs(crop.width - 200 * ratio)).toBeLessThanOrEqual(1);
  expect(Math.abs(crop.height - 120 * ratio)).toBeLessThanOrEqual(1);
}, 60_000);

test("a region's marker stays on its corner of the document as the page scrolls", async () => {
  const { person } = await onRegionPage();
  await region(person, { x: 100, y: 100 }, { x: 300, y: 250 }, "Spacing here");
  await person.scroll(400, 400, 100);
  await vi.waitFor(async () => expect(await person.evaluate("scrollY")).toBe(100), {
    timeout: 5_000,
  });
  const page = BrowserAnnotationCapture.parse(
    await person.execute({ action: "annotate_capture", target: { kind: "page" } }),
  );
  const width = Number(await person.evaluate("innerWidth"));
  // The marker's centre is the region's bottom-right corner, now 100 px higher in the viewport.
  // Sample beside the digit, right of the region so its dashed edge is not what is seen.
  expect(isMarkerBlue(await pixel(page, width, 300 + 6, 150))).toBe(true);
  expect(isMarkerBlue(await pixel(page, width, 300 + 6, 250))).toBe(false);
}, 60_000);
