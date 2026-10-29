import { chromium, type Frame } from "@playwright/test";
import { inlineVisualizationUrl } from "@ace/html";
import { inject, expect, test } from "vitest";

/*
 * An inline visualization is a frame the app sizes to its page and eases to each new height.
 * While it eases, the page briefly overflows the frame; a scrollbar that took room then would
 * narrow the page, re-wrap its text, change its height and start the ease again: the page
 * flickers between two layouts. Chromium runs with real scrollbars here (Playwright hides them
 * by default, which would hide this).
 */

const rows = Array.from(
  { length: 12 },
  (_, index) =>
    `<div style="display:flex;gap:12px;padding:10px;border:1px solid #ddd">` +
    `<b style="flex:1">#${1500 + index} Devices look disabled when only a simulator is shut down</b>` +
    `<span style="width:110px">Everyday usability</span></div>`,
).join("");
const page = `<!doctype html><html><head><title>Issues</title></head><body>${rows}</body></html>`;

/** The app's side: a 640px column whose frame eases to every height the page reports. */
const host = `<div id="column" style="width:640px;height:160px;transition:height .2s ease-out">
<iframe id="frame" style="width:100%;height:100%;border:0" sandbox="allow-scripts"></iframe></div>
<script>
addEventListener("message", (event) => {
  if (event.data?.type !== "ace.html.height") return;
  requestAnimationFrame(() => {
    document.getElementById("column").style.height = Math.ceil(event.data.height) + "px";
  });
});
</script>`;

const width = (frame: Frame) => frame.evaluate(() => document.documentElement.clientWidth);

test("an inline visualization keeps one width while its frame eases to a taller page", async () => {
  const browser = await chromium.launch({
    executablePath: inject("chromiumExecutable"),
    ignoreDefaultArgs: ["--hide-scrollbars"],
  });
  try {
    const tab = await browser.newPage({ viewport: { width: 900, height: 900 } });
    await tab.setContent(host);
    await tab.evaluate(
      (source) => {
        const frame = document.getElementById("frame");
        if (frame instanceof HTMLIFrameElement) frame.src = source;
      },
      inlineVisualizationUrl(page, {}, "static"),
    );
    await expect.poll(() => tab.frames().length, { timeout: 15_000 }).toBe(3);
    const outer = tab.frames().find((frame) => frame.parentFrame() === tab.mainFrame());
    const inner = outer?.childFrames()[0];
    if (!outer || !inner) throw new Error("Expected the outer document and its page");
    await expect
      .poll(() => tab.evaluate(() => document.getElementById("column")?.style.height))
      .not.toBe("160px");
    await tab.waitForTimeout(400);

    // The page grows, as an interactive page does when a row opens, and the frame eases after it.
    await inner.evaluate(() => {
      const opened = document.createElement("div");
      opened.style.height = "300px";
      document.body.append(opened);
    });
    const pageWidths = new Set<number>();
    const outerWidths = new Set<number>();
    for (let sample = 0; sample < 30; sample++) {
      pageWidths.add(await width(inner));
      outerWidths.add(await width(outer));
      await tab.waitForTimeout(16);
    }
    expect([...pageWidths]).toEqual([640]);
    expect([...outerWidths]).toEqual([640]);
  } finally {
    await browser.close();
  }
}, 60_000);
