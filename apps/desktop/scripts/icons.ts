#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appEnvironment, desktop, electronBinary } from "./common.ts";

/**
 * Renders the app and tray icons from their SVG masters in `apps/desktop/build`:
 *
 *   node apps/desktop/scripts/icons.ts
 *
 * - `build/icon.icns` (macOS, through an `.iconset` and `iconutil`) and `build/icon.png`
 *   (1024 px; electron-builder derives the Windows and Linux icons from it);
 * - `resources/trayTemplate.png` and `trayTemplate@2x.png`: black and alpha only, which macOS
 *   treats as a template image and tints for the menu bar.
 *
 * The installed Electron rasterizes: each size is drawn from the vector at that size, never
 * scaled down from a larger bitmap. The outputs are committed; rerun this after editing an SVG.
 */
interface Job {
  svg: string;
  size: number;
  out: string;
  /** Keep only coverage: every pixel black, alpha from the drawing. */
  template: boolean;
}

const build = join(desktop, "build");
const resources = join(desktop, "resources");

/** The `.iconset` names `iconutil` expects, with each file's pixel size. */
const iconset: Array<[name: string, size: number]> = [16, 32, 128, 256, 512].flatMap((points) => [
  [`icon_${points}x${points}.png`, points],
  [`icon_${points}x${points}@2x.png`, points * 2],
]);

/** Draws every job in one hidden Electron window and writes the PNGs. */
async function rasterize(jobs: Job[], work: string): Promise<void> {
  const jobFile = join(work, "jobs.json");
  const main = join(work, "render.cjs");
  await writeFile(jobFile, JSON.stringify(jobs));
  await writeFile(main, renderer);
  execFileSync(await electronBinary(), [main, jobFile], {
    stdio: "inherit",
    env: appEnvironment(process.env),
  });
}

/**
 * The Electron main script. The page loads each SVG as an image, draws it onto a canvas of
 * the target size (Chromium rasterizes SVG at the drawn size) and returns the PNG.
 */
const renderer = String.raw`
const { app, BrowserWindow } = require("electron");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

async function draw(svg, size, template) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const image = new Image(size, size);
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, size, size);
  URL.revokeObjectURL(url);
  if (template) {
    const pixels = context.getImageData(0, 0, size, size);
    for (let index = 0; index < pixels.data.length; index += 4)
      pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = 0;
    context.putImageData(pixels, 0, 0);
  }
  return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
}

app.dock?.hide();
app.whenReady().then(async () => {
  try {
    const jobs = JSON.parse(readFileSync(process.argv.at(-1), "utf8"));
    const window = new BrowserWindow({ show: false, width: 64, height: 64 });
    await window.loadURL("data:text/html,<!doctype html><title>icons</title>");
    for (const job of jobs) {
      const png = await window.webContents.executeJavaScript(
        "(" + draw.toString() + ")(" + JSON.stringify(job.svg) + "," + job.size + "," + job.template + ")",
      );
      mkdirSync(dirname(job.out), { recursive: true });
      writeFileSync(job.out, Buffer.from(png, "base64"));
    }
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
`;

if (process.platform !== "darwin") throw new Error("icons.ts needs macOS for iconutil");

const work = await mkdtemp(join(tmpdir(), "ace-icons-"));
try {
  const icon = await readFile(join(build, "icon.svg"), "utf8");
  const tray = await readFile(join(build, "tray.svg"), "utf8");
  const set = join(work, "icon.iconset");
  const jobs: Job[] = [
    ...iconset.map(([name, size]) => ({
      svg: icon,
      size,
      out: join(set, name),
      template: false,
    })),
    { svg: icon, size: 1024, out: join(build, "icon.png"), template: false },
    { svg: tray, size: 18, out: join(resources, "trayTemplate.png"), template: true },
    { svg: tray, size: 36, out: join(resources, "trayTemplate@2x.png"), template: true },
  ];
  await rasterize(jobs, work);
  execFileSync("iconutil", ["-c", "icns", set, "-o", join(build, "icon.icns")], {
    stdio: "inherit",
  });
  for (const job of jobs) if (!job.out.startsWith(set)) console.log(`[icons] ${job.out}`);
  console.log(`[icons] ${join(build, "icon.icns")}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
