import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { annotationFixture, executablePath, type Box } from "./annotation-test-support.ts";
import { chromeDesktop } from "./relay-chrome-test-support.ts";

const test = it.skipIf(!executablePath);
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** Meta, as CDP numbers modifiers; with "a" it selects all. */
const meta = 4;
const Inline = z.tuple([z.string(), z.string()]);
const centre = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const until = <T>(check: () => Promise<T>) => vi.waitFor(check, { timeout: 5_000, interval: 25 });

/**
 * A person annotating /styles in a real Chrome behind the desktop relay. The overlay's own
 * controls sit in a closed shadow root, so they are found the way DevTools finds them.
 */
async function stylesPage() {
  if (!executablePath) throw new Error("No Chromium");
  const desktop = await chromeDesktop(executablePath);
  closers.push(desktop.close);
  const f = await annotationFixture(desktop);
  const person = f.connect("person");
  await person.subscribe();
  await person.execute({ action: "navigate", url: `${f.origin}/styles` });
  await person.execute({ action: "annotate", operation: "start", config: { theme: "dark" } });
  await person.event("ready");

  const control = (label: string) =>
    vi.waitFor(
      async () => {
        const box = await desktop.labelled(label);
        if (!box || box.width === 0) throw new Error(`${label} is not on screen`);
        return box;
      },
      { timeout: 5_000, interval: 50 },
    );
  const press = async (label: string) => {
    const at = centre(await control(label));
    await person.click(at.x, at.y);
  };
  const fill = async (label: string, value: string) => {
    await press(label);
    await person.press("a", { code: "KeyA", modifiers: meta });
    await person.type(value);
  };
  const open = async (selector: string) => {
    const at = centre(await person.box(selector));
    await person.click(at.x, at.y);
  };
  const computed = async (selector: string, property: string) =>
    String(
      await person.evaluate(
        `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).getPropertyValue(${JSON.stringify(property)})`,
      ),
    );
  const inline = async (selector: string, property: string) =>
    Inline.parse(
      await person.evaluate(
        `(() => { const s = document.querySelector(${JSON.stringify(selector)}).style; return [s.getPropertyValue(${JSON.stringify(property)}), s.getPropertyPriority(${JSON.stringify(property)})]; })()`,
      ),
    );
  return { f, desktop, person, control, press, fill, open, computed, inline, until };
}

test("a style edit previews live, and Save reports computed values before and after", async () => {
  const page = await stylesPage();
  const { person } = page;
  await page.open("#title");
  await person.type("Redder and bigger");
  await page.press("Edit styles");
  await page.fill("Text color", "rgb(200, 0, 0)");
  await page.until(async () =>
    expect(await page.computed("#title", "color")).toBe("rgb(200, 0, 0)"),
  );
  await page.fill("Font size", "40px");
  await page.until(async () => expect(await page.computed("#title", "font-size")).toBe("40px"));
  await person.press("Enter");
  const { annotation } = await person.event("saved");
  expect(annotation.comment).toBe("Redder and bigger");
  expect(annotation.styles).toEqual([
    { property: "color", before: "rgb(10, 20, 30)", after: "rgb(200, 0, 0)" },
    { property: "font-size", before: "28px", after: "40px" },
  ]);
  // Saved edits stay on the page while annotating, and leave with annotate mode.
  expect(await page.computed("#title", "color")).toBe("rgb(200, 0, 0)");
  await person.execute({ action: "annotate", operation: "stop" });
  await person.event("ended");
  expect(await page.computed("#title", "color")).toBe("rgb(10, 20, 30)");
  expect(await page.inline("#title", "color")).toEqual(["rgb(10, 20, 30)", ""]);
  expect(await page.inline("#title", "font-size")).toEqual(["28px", ""]);
}, 90_000);

test("Cancel restores the element's own inline values and their priority", async () => {
  const page = await stylesPage();
  const { person } = page;
  await page.open("#lead");
  await page.press("Edit styles");
  await page.fill("Opacity", "0.3");
  await page.fill("Background", "rgb(0, 128, 0)");
  await page.until(async () => expect(await page.computed("#lead", "opacity")).toBe("0.3"));
  expect(await page.computed("#lead", "background-color")).toBe("rgb(0, 128, 0)");
  await page.press("Cancel");
  await page.until(async () =>
    expect(await page.inline("#lead", "opacity")).toEqual(["0.9", "important"]),
  );
  expect(await page.inline("#lead", "background-color")).toEqual(["", ""]);
  expect(await page.computed("#lead", "background-color")).toBe("rgba(0, 0, 0, 0)");
  expect(person.events().some((event) => event.kind === "saved")).toBe(false);
}, 90_000);

test("holding View original hides every preview until the button is let go", async () => {
  const page = await stylesPage();
  const { person } = page;
  await page.open("#title");
  await page.press("Edit styles");
  await page.fill("Text color", "rgb(200, 0, 0)");
  await person.press("Enter");
  await person.event("saved");
  const saved = person.events().length;
  await page.open("#note");
  await page.press("Edit styles");
  await page.fill("Text", "Changed note");
  await person.press("Enter");
  await person.event("saved", saved);

  const button = await page.control("Hold to view original");
  const at = { x: button.x + button.width / 2, y: button.y + button.height / 2 };
  await person.mouse("mousePressed", at.x, at.y);
  await page.until(async () =>
    expect(await page.computed("#title", "color")).toBe("rgb(10, 20, 30)"),
  );
  expect(await person.evaluate("document.querySelector('#note').textContent")).toBe("Note text");
  await person.mouse("mouseReleased", at.x, at.y);
  await page.until(async () =>
    expect(await page.computed("#title", "color")).toBe("rgb(200, 0, 0)"),
  );
  expect(await person.evaluate("document.querySelector('#note').textContent")).toBe("Changed note");
}, 90_000);

test("text is editable only on an element without child elements", async () => {
  const page = await stylesPage();
  const { person } = page;
  await page.open("#lead");
  await page.press("Edit styles");
  await page.control("Text color");
  expect(await page.desktop.labelled("Text")).toBeUndefined();
  await person.press("Escape");

  const node = "document.querySelector('#note').firstChild";
  await person.evaluate(`window.noteNode = ${node}`);
  await page.open("#note");
  await page.press("Edit styles");
  await page.fill("Text", "Fresh note");
  await page.until(async () =>
    expect(await person.evaluate("document.querySelector('#note').textContent")).toBe("Fresh note"),
  );
  await person.press("Enter");
  expect((await person.event("saved")).annotation.text).toEqual({
    before: "Note text",
    after: "Fresh note",
  });
  await person.execute({ action: "annotate", operation: "stop" });
  await person.event("ended");
  expect(await person.evaluate("document.querySelector('#note').textContent")).toBe("Note text");
  // The page's own text node is kept, so frameworks holding it keep working.
  expect(await person.evaluate(`${node} === window.noteNode`)).toBe(true);
}, 90_000);

test("a marker sits at its element's corner without covering the first characters", async () => {
  const page = await stylesPage();
  for (const [index, selector] of ["#title", "#note"].entries()) {
    await page.f.pin(page.person, selector, `Note ${index + 1}`);
    // Once its entrance has finished, the marker is full size.
    const marker = await page.until(async () => {
      const box = await page.control(`Annotation ${index + 1}`);
      expect(box.width).toBeGreaterThan(21);
      return box;
    });
    const element = await page.person.box(selector);
    const glyph = z
      .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
      .parse(
        await page.person.evaluate(
          `(() => { const r = document.createRange(); const t = document.querySelector(${JSON.stringify(selector)}).firstChild; r.setStart(t, 0); r.setEnd(t, 1); const b = r.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`,
        ),
      );
    const overlaps =
      marker.x < glyph.x + glyph.width &&
      glyph.x < marker.x + marker.width &&
      marker.y < glyph.y + glyph.height &&
      glyph.y < marker.y + marker.height;
    expect(overlaps).toBe(false);
    // Still pinned to the element: its centre is within a marker's width of the corner.
    const middle = centre(marker);
    expect(Math.hypot(middle.x - element.x, middle.y - element.y)).toBeLessThan(22);
  }
}, 90_000);

test("deleting a marker renumbers the ones after it and the next pin continues the count", async () => {
  const page = await stylesPage();
  const { f, person } = page;
  const first = await f.pin(person, "#title", "One");
  const second = await f.pin(person, "#lead", "Two");
  const third = await f.pin(person, "#note", "Three");
  const before = person.events().length;
  await page.press("Annotation 1");
  await page.press("Delete annotation");
  expect(await person.event("removed", before)).toMatchObject({ id: first.id });
  await page.until(async () => {
    const renumbered = person
      .events()
      .slice(before)
      .flatMap((event) => (event.kind === "saved" ? [event.annotation] : []));
    expect(renumbered.map(({ id, number }) => ({ id, number }))).toEqual([
      { id: second.id, number: 1 },
      { id: third.id, number: 2 },
    ]);
  });
  expect(await page.desktop.labelled("Annotation 3")).toBeUndefined();
  await page.control("Annotation 2");
  expect((await f.pin(person, "#title", "Again")).number).toBe(3);
}, 90_000);
