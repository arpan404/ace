import { expect, it, vi } from "vitest";
import { BrowserAnnotationCapture } from "@ace/protocol";
import {
  annotationFixture,
  executablePath,
  isAnnotationMark,
  markerCentre,
  pixel,
} from "./annotation-test-support.ts";

const test = it.skipIf(!executablePath);

test("a click pins a numbered annotation with a unique selector and never reaches the page", async () => {
  const f = await annotationFixture();
  const person = await f.annotating();
  expect(f.service.state("thread").annotation).toEqual({ owner: "person" });
  const annotation = await f.pin(person, "p.lead", "Make this one line");
  expect(annotation).toMatchObject({
    number: 1,
    comment: "Make this one line",
    url: `${f.origin}/`,
    title: "Pricing",
    styles: [],
    element: { tag: "p", text: "Start your free trial", xpath: "/html/body/main/section/p[1]" },
  });
  expect(
    await person.evaluate(
      `(() => { const found = document.querySelectorAll(${JSON.stringify(annotation.element.selector)}); return found.length === 1 && found[0] === document.querySelector("p.lead"); })()`,
    ),
  ).toBe(true);
  expect(await person.evaluate("window.pageClicks")).toBe(0);
  const second = await f.pin(person, "p.lead:nth-of-type(2)", "And this");
  expect(second.number).toBe(2);
  expect(second.element.selector).not.toBe(annotation.element.selector);
}, 60_000);

test("a page with a strict CSP and required Trusted Types still mounts the overlay", async () => {
  const f = await annotationFixture();
  const person = f.connect("person");
  await person.subscribe();
  await person.execute({ action: "navigate", url: `${f.origin}/csp` });
  await person.execute({ action: "annotate", operation: "start" });
  expect(await person.event("ready")).toMatchObject({ url: `${f.origin}/csp`, title: "Locked" });
  // The page forbids eval, so coordinates come from its known layout: the heading at the top.
  await person.click(60, 40);
  await person.type("Too loud");
  await person.press("Enter");
  expect((await person.event("saved")).annotation).toMatchObject({
    comment: "Too loud",
    element: { tag: "h1", selector: "h1", text: "Locked down" },
  });
}, 60_000);

test("wheel input still scrolls an inner container and the marker follows its element", async () => {
  const f = await annotationFixture();
  const person = await f.annotating();
  const scroller = await person.box("#scroller");
  await person.scroll(scroller.x + 100, scroller.y + 100, 520);
  await vi.waitFor(
    async () => expect(await person.evaluate("scroller.scrollTop")).toBeGreaterThan(400),
    { timeout: 5_000 },
  );
  await f.pin(person, "#deep", "Deep item spacing");
  // Over the marker itself, the wheel still scrolls the container underneath.
  const marker = markerCentre(await person.box("#deep"));
  await person.scroll(marker.x, marker.y, -60);
  await vi.waitFor(
    async () => expect(await person.evaluate("scroller.scrollTop")).toBeLessThan(500),
    { timeout: 5_000 },
  );
  const box = await person.box("#deep");
  const page = BrowserAnnotationCapture.parse(
    await person.execute({ action: "annotate_capture", target: { kind: "page" } }),
  );
  const width = Number(await person.evaluate("innerWidth"));
  // Sample beside the digit, inside the 22 px marker at the element's new position.
  const moved = markerCentre(box);
  expect(isAnnotationMark(await pixel(page, width, moved.x - 7, moved.y))).toBe(true);
}, 60_000);

test("a page capture keeps the markers but leaves out the bar", async () => {
  const f = await annotationFixture();
  const person = await f.annotating();
  await f.pin(person, "p.lead", "Bigger");
  const page = BrowserAnnotationCapture.parse(
    await person.execute({ action: "annotate_capture", target: { kind: "page" } }),
  );
  expect(page.mimeType).toBe("image/jpeg");
  const width = Number(await person.evaluate("innerWidth"));
  const height = Number(await person.evaluate("innerHeight"));
  const box = await person.box("p.lead");
  const marker = markerCentre(box);
  expect(isAnnotationMark(await pixel(page, width, marker.x - 7, marker.y))).toBe(true);
  // The bar is centred near the bottom; the capture shows the white page there instead.
  const barSpot = [width / 2, height - 37] as const;
  expect(Math.min(...(await pixel(page, width, ...barSpot)))).toBeGreaterThan(230);
  // Outside a capture the bar is back on screen.
  const live = await f.service.screenshot("thread");
  const liveImage = { data: Buffer.from(live).toString("base64"), width: 0 };
  const { default: sharp } = await import("sharp");
  liveImage.width = (await sharp(Buffer.from(live)).metadata()).width ?? 0;
  expect(Math.min(...(await pixel(liveImage, width, ...barSpot)))).toBeLessThan(200);
}, 60_000);

test("an element crop is the element with an 8 px margin, its long edge at most 1024 px", async () => {
  const f = await annotationFixture();
  const person = await f.annotating();
  const lead = await f.pin(person, "p.lead", "Lead copy");
  const box = await person.box("p.lead");
  const ratio = Number(await person.evaluate("devicePixelRatio"));
  const crop = BrowserAnnotationCapture.parse(
    await person.execute({
      action: "annotate_capture",
      target: { kind: "annotation", id: lead.id },
    }),
  );
  expect(crop.mimeType).toBe("image/png");
  expect(Math.abs(crop.width - (box.width + 16) * ratio)).toBeLessThanOrEqual(1);
  expect(Math.abs(crop.height - (box.height + 16) * ratio)).toBeLessThanOrEqual(1);
  // A tall element inside a scroller crops to its visible part, scaled to 1024 px.
  const scroller = await person.box("#scroller");
  const spacer = await f.pin(person, "#scroller > div", "Empty space");
  const tall = BrowserAnnotationCapture.parse(
    await person.execute({
      action: "annotate_capture",
      target: { kind: "annotation", id: spacer.id },
    }),
  );
  expect(Math.max(tall.width, tall.height)).toBeLessThanOrEqual(1024);
  expect(tall.height / ratio).toBeLessThanOrEqual(scroller.height + 16);
  await expect(
    person.execute({ action: "annotate_capture", target: { kind: "annotation", id: "missing" } }),
  ).rejects.toThrow();
}, 60_000);

test("reopening a marker edits its comment, and Escape closes it without a change", async () => {
  const f = await annotationFixture();
  const person = await f.annotating();
  const annotation = await f.pin(person, "p.lead", "First thought");
  const before = person.events().length;
  await person.execute({
    action: "annotate",
    operation: "command",
    command: { op: "edit", id: annotation.id },
  });
  await person.type(" and more");
  await person.press("Enter");
  expect((await person.event("saved", before)).annotation).toMatchObject({
    id: annotation.id,
    number: 1,
    comment: "First thought and more",
  });
  const box = await person.box("p.lead");
  // Clicking the marker reopens the editor; Escape closes it without a change.
  const marker = markerCentre(box);
  await person.click(marker.x, marker.y);
  await person.press("Escape");
  expect(
    person
      .events()
      .slice(before)
      .filter((event) => event.kind === "saved"),
  ).toHaveLength(1);
  expect(await person.evaluate("window.pageClicks")).toBe(0);
}, 60_000);

test("a click on an embedded frame pins the frame and never reaches the framed page", async () => {
  const f = await annotationFixture();
  const person = f.connect("person");
  await person.subscribe();
  await person.execute({ action: "navigate", url: `${f.origin}/framed` });
  await person.execute({ action: "annotate", operation: "start" });
  await person.event("ready");
  const annotation = await f.pin(person, "#embed", "Taller frame");
  expect(annotation.element).toMatchObject({ tag: "iframe", selector: "#embed" });
  expect(await person.evaluate("document.querySelector('#embed').contentWindow.frameClicks")).toBe(
    0,
  );
  await person.execute({ action: "annotate", operation: "stop" });
  expect(
    await person.evaluate("getComputedStyle(document.querySelector('#embed')).pointerEvents"),
  ).toBe("auto");
}, 60_000);
