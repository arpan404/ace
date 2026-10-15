import { mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";

/*
 * Attachment overflow (issues #808 and #809), measured in a real browser where layout
 * exists: a staged image's name never escapes its composer chip, and a sent image's tiles
 * never escape the user bubble — at desktop width and at a narrow 420px viewport.
 */

const out = process.env.ACE_SHOTS_DIR ?? "/tmp/aceshots-overflow";
mkdirSync(out, { recursive: true });

// First paint compiles routes on demand; allow headroom on a cold dev server.
test.setTimeout(120_000);

// A valid 1x1 PNG so staged and sent images paint instead of falling back to "unavailable".
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A valid solid-colour PNG at screenshot dimensions, so sent tiles size like #808's. */
function bigPng(width: number, height: number, rgb: [number, number, number] = [200, 60, 60]) {
  const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, "ascii");
    const code = Buffer.alloc(4);
    code.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
    return Buffer.concat([header, data, code]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const row = Buffer.alloc(1 + width * 3, 0);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = rgb[0];
    row[1 + x * 3 + 1] = rgb[1];
    row[1 + x * 3 + 2] = rgb[2];
  }
  const idat = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const screenshotPng = bigPng(1280, 800);

const names = {
  // 24 chars of wide glyphs: under the middle-truncation threshold, wider than the w-28 card.
  wideShort: "W".repeat(20) + ".png",
  long: `site-visit-${"a".repeat(70)}-final-v2.png`,
  veryLong: `${"screenshot-".repeat(14)}2026-10-15.png`,
  longExtension: `photo.${"x".repeat(60)}`,
};

async function openThread(page: Page) {
  await page.goto("/t/thread-replay-cursor");
  const message = page.getByRole("combobox", { name: "Message" });
  await message.waitFor();
  await page.getByRole("feed", { name: "Transcript" }).waitFor();
  await page.getByRole("button", { name: /^Access:/ }).waitFor();
  await page.getByRole("button", { name: /^Model:/ }).waitFor();
  return message;
}

async function stageImages(page: Page, files: { name: string }[]) {
  await page
    .getByLabel("Files to attach")
    .setInputFiles(files.map((file) => ({ name: file.name, mimeType: "image/png", buffer: png })));
  const chips = page.getByRole("list", { name: "Attachments" });
  for (const file of files) {
    await expect(chips.getByRole("button", { name: `Remove ${file.name}` })).toBeVisible();
  }
  // Let uploads settle so chips show their steady state.
  await expect(chips.getByRole("progressbar")).toHaveCount(0);
  return chips;
}

/** Every element matching `selector` clips nothing: nothing paints past its own box. */
async function expectClipped(page: Page, selector: string) {
  const overflows = await page.evaluate((sel) => {
    const bad: { tag: string; label: string; by: number }[] = [];
    for (const el of document.querySelectorAll(sel)) {
      const html = el as HTMLElement;
      const by = Math.max(
        html.scrollWidth - html.clientWidth,
        html.scrollHeight - html.clientHeight,
      );
      if (by > 1) {
        bad.push({
          tag: html.tagName.toLowerCase(),
          label: (html.getAttribute("aria-label") ?? html.textContent ?? "").slice(0, 60),
          by: Math.round(by * 10) / 10,
        });
      }
    }
    return bad;
  }, selector);
  expect(overflows, selector).toEqual([]);
}

test("composer image chips keep very long names inside the card", async ({ page }) => {
  await openThread(page);
  const files = [names.wideShort, names.long, names.veryLong, names.longExtension].map((name) => ({
    name,
  }));
  const chips = await stageImages(page, files);
  await expectClipped(page, 'ul[aria-label="Attachments"] > li');
  await expectClipped(page, 'ul[aria-label="Attachments"] [data-chip-open]');
  await page
    .locator('[data-slot="composer"]')
    .screenshot({ path: `${out}/composer-long-names.png` });
  // The names still read: head truncated, extension visible.
  await expect(chips.getByText(/\.png$/).first()).toBeVisible();
});

test("a narrow composer keeps long-name chips inside the viewport", async ({ page }) => {
  await openThread(page);
  // Shrink after load: the composer must keep chips inside at any width.
  await page.setViewportSize({ width: 420, height: 800 });
  await stageImages(page, [{ name: names.veryLong }, { name: names.long }]);
  await expectClipped(page, 'ul[aria-label="Attachments"] > li');
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(pageOverflow).toBeLessThanOrEqual(1);
  await page.locator('[data-slot="composer"]').screenshot({ path: `${out}/composer-narrow.png` });
});

test("the user bubble keeps sent image tiles inside at desktop and narrow widths", async ({
  page,
}) => {
  for (const width of [1440, 420]) {
    // An idle fixture thread: the send lands in the transcript right away (no queue).
    await page.goto("/t/thread-multi-day");
    await page.setViewportSize({ width, height: 800 });
    const message = page.getByRole("combobox", { name: "Message" });
    await expect(message).toBeVisible();
    const stamp = `Overflow probe ${width} ${Date.now()}`;
    await page.getByLabel("Files to attach").setInputFiles({
      name: names.long,
      mimeType: "image/png",
      buffer: screenshotPng,
    });
    await message.fill(stamp);
    const chips = page.getByRole("list", { name: "Attachments" });
    await expect(chips.getByRole("progressbar")).toHaveCount(0);
    await page.keyboard.press("Enter");
    const bubble = page.locator(".bg-bubble", { hasText: stamp });
    await expect(bubble).toBeVisible();
    // The attachment renders as an image tile (320px wide at these dimensions), not a chip.
    await expect(bubble.getByRole("list", { name: "Image" })).toBeVisible();
    await expectClipped(page, ".bg-bubble");
    // Every tile box sits within its bubble's box.
    const check = await bubble.evaluate((el) => {
      const outer = el.getBoundingClientRect();
      const bad: string[] = [];
      for (const tile of el.querySelectorAll("ul, li, button, img")) {
        const box = tile.getBoundingClientRect();
        if (box.right - (outer.x + outer.width) > 1 || box.x - outer.x < -1) {
          bad.push(
            `${tile.tagName.toLowerCase()} ${Math.round(box.width)}x${Math.round(box.height)}`,
          );
        }
      }
      return bad;
    });
    expect(check).toEqual([]);
    await bubble.screenshot({ path: `${out}/bubble-${width}.png` });
  }
});
