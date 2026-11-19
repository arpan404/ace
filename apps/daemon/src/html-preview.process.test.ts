import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BrowserService, detectChromium } from "@ace/browser";
import { htmlLayout, MeasuredLayouts, previewHtml } from "./html-preview.ts";

/*
 * Why a process test: what html_preview reports comes from a real layout engine laying the page
 * out inside the transcript's sandboxed, out-of-process frame. The report wording itself is
 * covered by packages/html/src/preview.test.ts.
 */
let home: string;
let service: BrowserService;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "ace-html-preview-"));
  const executablePath = await detectChromium();
  service = new BrowserService({
    dataDir: home,
    evaluatePolicy: () => false,
    wakeWatch: false,
    ...(executablePath ? { executablePath } : {}),
  });
});
afterAll(async () => {
  await service.close();
  await rm(home, { recursive: true, force: true });
});

const page = `<!doctype html><html><head><style>
.pair{display:grid;grid-template-columns:300px 300px;gap:16px}
</style></head><body>
<h2>Plan</h2>
<div class="pair"><div class="card">Before</div><div class="card after">After</div></div>
<svg viewBox="0 0 900 200" width="100%"><text x="10" y="60" font-size="16">Axis label</text></svg>
<script>document.body.append(Object.assign(document.createElement('p'), { textContent: 'built by script', style: 'font-size:9px' }))</script>
</body></html>`;

/** A PNG's width from its IHDR chunk. */
const pngWidth = (data: Buffer) => data.readUInt32BE(16);

it("an agent sees its page at phone, column and side-panel width with the problems at each width named", async () => {
  const result = await previewHtml(
    service,
    { html: page, mode: "interactive", scheme: "dark", widths: [360, 760, 1200] },
    AbortSignal.timeout(25_000),
  );
  const [phone, column, panel] = result.report.split("\n");
  // Two 300px columns do not fit a 360px phone; the second card sticks out past the edge.
  expect(phone).toMatch(/^360px: height \d+px; overflows sideways/);
  expect(phone).toContain("div.card.after 300px wide");
  // The SVG's viewBox shrinks its 16px label below readable size on a phone, not in the column.
  expect(phone).toMatch(/"Axis label" [0-9.]+px/);
  expect(column).toMatch(/^760px: height \d+px; no sideways overflow/);
  expect(column).not.toContain("Axis label");
  // An interactive page's script ran before it was measured.
  expect(column).toContain('"built by script" 9px');
  expect(panel).toMatch(/^1200px: height \d+px; no sideways overflow/);
  expect(result.images.map((image) => [image.mimeType, pngWidth(image.data)])).toEqual([
    ["image/png", 360],
    ["image/png", 760],
    ["image/png", 1200],
  ]);
  // What html_render would refuse: the card past the phone's edge and the shrunken SVG label.
  // The 9px line is only reported.
  expect(result.problems?.map((entry) => entry.code)).toEqual(["overflow", "text-too-small"]);
  expect(result.problems?.[1]?.message).toContain('"Axis label"');
  expect(result.problems?.[0]?.message).toContain("div.card.after");
}, 30_000);

it("publishing lays a page out at phone width, and reuses the measurement of a page just previewed", async () => {
  const layouts = new MeasuredLayouts();
  const withBrowser = htmlLayout(() => service, layouts);
  const signal = AbortSignal.timeout(25_000);
  const fits = page
    .replace("300px 300px", "repeat(auto-fit,minmax(min(100%,240px),1fr))")
    .replace("0 0 900 200", "0 0 400 200");
  expect(await withBrowser.measure({ html: fits, mode: "static" }, signal)).toEqual([]);
  const overflowing = await withBrowser.measure({ html: page, mode: "static" }, signal);
  expect(overflowing?.map((entry) => entry.code)).toEqual(["overflow", "text-too-small"]);
  // With the browser gone, a page already measured keeps its result; a new one can't be measured.
  const withoutBrowser = htmlLayout(() => undefined, layouts);
  expect(
    (await withoutBrowser.measure({ html: page, mode: "static" }, signal))?.map((e) => e.code),
  ).toEqual(["overflow", "text-too-small"]);
  expect(
    await withoutBrowser.measure({ html: `${page}<!-- edited -->`, mode: "static" }, signal),
  ).toBe(undefined);
}, 30_000);
