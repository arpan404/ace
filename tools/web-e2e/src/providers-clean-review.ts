import { chromium } from "@playwright/test";
import { readFile, readdir, writeFile } from "node:fs/promises";

const before = "/tmp/ace-orch/shots/ui-providers-clean";
const out = `${before}/followup`;
const themes = ["light", "dark", "midnight", "graphite", "paper", "slate", "contrast"];
const files = (await readdir(out)).filter(
  (file) =>
    file.endsWith(".png") &&
    !file.includes("comparison") &&
    !file.includes("review") &&
    !file.startsWith("before-after"),
);
const groups = new Map<string, string[]>();
for (const file of files) {
  const suffix = themes.find((theme) => file.match(new RegExp(`-${theme}-(1440|390)\\.png$`)));
  if (!suffix) continue;
  const surface = file.replace(new RegExp(`-${suffix}-(1440|390)\\.png$`), "");
  const group = groups.get(surface) ?? [];
  group.push(file);
  groups.set(surface, group);
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2000, height: 1800 } });
const source = async (file: string) =>
  `data:image/png;base64,${(await readFile(file)).toString("base64")}`;
const render = async (html: string, path: string) => {
  await page.setContent(html);
  await page
    .locator("img")
    .evaluateAll((elements) =>
      Promise.all(
        elements.map((element) =>
          element instanceof HTMLImageElement ? element.decode() : Promise.resolve(),
        ),
      ),
    );
  await page.locator("main").screenshot({ path, animations: "disabled" });
};
try {
  for (const [surface, candidates] of groups) {
    const images = candidates.toSorted(
      (a, b) =>
        themes.findIndex((theme) => a.includes(`-${theme}-`)) -
          themes.findIndex((theme) => b.includes(`-${theme}-`)) || a.localeCompare(b),
    );
    const entries = await Promise.all(
      images.map(
        async (file) => `<div><p>${file}</p><img src="${await source(`${out}/${file}`)}"></div>`,
      ),
    );
    await render(
      `<style>body{margin:0;background:#777;color:white;font:14px system-ui}main{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}img{width:100%;height:400px;object-fit:contain;object-position:top}p{margin:8px}</style><main>${entries.join("")}</main>`,
      `${out}/${surface}-review.png`,
    );
  }
  for (const surface of ["providers", "provider", "usage", "add-account"])
    for (const theme of ["light", "dark"])
      for (const width of [1440, 390]) {
        const file = `${surface}-${theme}-${width}.png`;
        const entries = await Promise.all(
          [before, out].map(
            async (directory, index) =>
              `<div><h2>${index ? "After" : "Before"} · ${file}</h2><img src="${await source(`${directory}/${file}`)}"></div>`,
          ),
        );
        await render(
          `<style>body{margin:0;padding:16px;background:#777;color:white;font:14px system-ui}main{display:flex;width:max-content;gap:16px}img{display:block;width:${width === 1440 ? 960 : 390}px}h2{font-size:14px}</style><main>${entries.join("")}</main>`,
          `${out}/before-after-${surface}-${theme}-${width}.png`,
        );
      }
  const all = (await readdir(out)).filter((file) => file.endsWith(".png")).toSorted();
  await writeFile(`${out}/screenshots.md`, all.map((file) => `- ${out}/${file}`).join("\n") + "\n");
  process.stdout.write(`Reviewed sets: ${groups.size}; PNGs: ${all.length}\n`);
} finally {
  await browser.close();
}
