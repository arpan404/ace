import { expect, test, type Page } from "@playwright/test";

/*
 * The composer's geometry (SPEC "Composer"): its text inset never moves, its footer controls
 * share one centre line, it grows a whole line at a time without moving the footer, and its
 * shell shares the transcript column's edges. Measured in a real browser, where layout exists.
 */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Geometry {
  shell: Box;
  input: Box;
  /** Where the first character of text sits. */
  textLeft: number;
  plusInk: Box;
  controls: { name: string; box: Box }[];
  column: Box;
}

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    // Runs in the page, so it can't share a helper from this file's scope.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const box = (el: Element | null): Box => {
      if (!el) throw new Error("missing element");
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const shell = document.querySelector('[data-slot="composer"]');
    const input = shell?.querySelector('[role="combobox"][contenteditable]');
    const footer = shell?.querySelector('[data-slot="composer-footer"]');
    if (!shell || !input || !footer) throw new Error("no composer");
    const inputBox = box(input);
    return {
      shell: box(shell),
      input: inputBox,
      textLeft: inputBox.x + Number.parseFloat(getComputedStyle(input).paddingLeft),
      plusInk: box(footer.querySelector('button[aria-label="Add files and context"] svg')),
      controls: [...footer.querySelectorAll("button, [role=meter]")].map((el) => ({
        name: el.getAttribute("aria-label") ?? "",
        box: box(el),
      })),
      column: box(document.querySelector('[role="feed"]')),
    };
  });
}

const centre = (box: Box) => box.y + box.height / 2;

/** Every footer control on one centre line, each the same whole-pixel height. */
function expectAlignedFooter(g: Geometry) {
  expect(g.controls.length).toBeGreaterThanOrEqual(3);
  const line = centre(g.controls[0]!.box);
  for (const control of g.controls) {
    expect(Math.abs(centre(control.box) - line), control.name).toBeLessThanOrEqual(0.5);
    expect(control.box.height, control.name).toBe(32);
  }
  // The + glyph starts exactly where the text starts.
  expect(g.plusInk.x).toBe(g.textLeft);
  // Whole pixels: no fractional heights anywhere in the structure.
  expect(Number.isInteger(g.shell.height)).toBe(true);
  expect(Number.isInteger(g.input.height)).toBe(true);
  // The primary action sits as far from the right edge as from the bottom.
  const action = g.controls.at(-1)!.box;
  const right = g.shell.x + g.shell.width - (action.x + action.width);
  const bottom = g.shell.y + g.shell.height - (action.y + action.height);
  expect(right).toBe(bottom);
}

async function openThread(page: Page) {
  await page.goto("/t/thread-replay-cursor");
  const message = page.getByRole("combobox", { name: "Message" });
  await message.waitFor();
  await page.getByRole("feed", { name: "Transcript" }).waitFor();
  // The footer's pickers load just after first paint; measure once they are in.
  await page.getByRole("button", { name: /^Approvals:/ }).waitFor();
  await page.getByRole("button", { name: /^Model:/ }).waitFor();
  return message;
}

test("the composer keeps its text inset and footer line from one line to three", async ({
  page,
}) => {
  const message = await openThread(page);
  const one = await geometry(page);
  expectAlignedFooter(one);
  expect(one.input.height).toBe(44);

  await message.fill("First line\nSecond line\nThird line");
  const three = await geometry(page);
  expectAlignedFooter(three);
  // Two more lines, 20px each; the shell grows upward and the footer stays.
  expect(three.input.height).toBe(one.input.height + 40);
  expect(three.shell.height).toBe(one.shell.height + 40);
  expect(centre(three.controls[0]!.box)).toBe(centre(one.controls[0]!.box));
  expect(three.textLeft).toBe(one.textLeft);

  // Wrapping a long line behaves like a newline: no jump of the inset.
  await message.fill("word ".repeat(400));
  const wrapped = await geometry(page);
  expect(wrapped.textLeft).toBe(one.textLeft);
  expectAlignedFooter(wrapped);
});

test("attachments add a row above the text without moving its inset or the footer", async ({
  page,
}) => {
  const message = await openThread(page);
  await message.fill("See the log");
  const before = await geometry(page);
  await page.getByLabel("Files to attach").setInputFiles({
    name: "relay.log",
    mimeType: "text/plain",
    buffer: Buffer.from("2026-10-03 resume seq 0"),
  });
  const chips = page.getByRole("list", { name: "Attachments" });
  await expect(chips.getByText("relay.log")).toBeVisible();
  const after = await geometry(page);
  expectAlignedFooter(after);
  expect(after.textLeft).toBe(before.textLeft);
  expect(after.input.height).toBe(before.input.height);
  expect(centre(after.controls[0]!.box)).toBe(centre(before.controls[0]!.box));
});

test("the composer shares the transcript column's edges, with or without a side panel", async ({
  page,
}) => {
  await openThread(page);
  for (const panel of [false, true]) {
    if (panel) {
      await page.keyboard.press("ControlOrMeta+Shift+d");
      await page.getByRole("region", { name: "Thread panel" }).waitFor();
      // Let the panel finish opening before measuring.
      await page.waitForTimeout(400);
    }
    const g = await geometry(page);
    expect(g.shell.x).toBe(g.column.x);
    expect(g.shell.width).toBe(g.column.width);
    expectAlignedFooter(g);
  }
});

test("a narrow composer keeps every control on the line and drops labels to icons", async ({
  page,
}) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await openThread(page);
  const g = await geometry(page);
  expectAlignedFooter(g);
  await expect(page.getByRole("button", { name: "Approvals: Auto-review" })).toHaveText("");
});

test("an unsent draft survives a reload", async ({ page }) => {
  const message = await openThread(page);
  await message.fill("Check the cold-start path before merging");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Message" })).toHaveText(
    "Check the cold-start path before merging",
  );
});
