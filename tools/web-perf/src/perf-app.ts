import { chromium, type Browser } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreview } from "./preview-server.ts";

/*
 * The production build in `--mode perf` (ADR 0056), served by `vite preview` and opened in
 * Chromium: its client worker is fed by the endless agent (`?rate=` events/s, `?history=`
 * items of older history). Shared by the main-thread and the memory budgets.
 */

const web = new URL("../../../apps/web/", import.meta.url).pathname;

/**
 * One build per process: every run here serves the same source, and a production build takes
 * long enough that rebuilding it for each test would eat most of that test's time. It is built
 * off the event loop and removed when the process exits.
 */
let build: Promise<string> | undefined;
function perfBuild(): Promise<string> {
  build ??= (async () => {
    const out = mkdtempSync(join(tmpdir(), "ace-web-perf-"));
    process.once("exit", () => rmSync(out, { recursive: true, force: true }));
    await promisify(execFile)(
      "bunx",
      ["vite", "build", "--mode", "perf", "--outDir", out, "--emptyOutDir"],
      { cwd: web, maxBuffer: 64 * 1024 * 1024 },
    );
    return out;
  })();
  return build;
}

export async function withPerfApp<T>(
  run: (app: { browser: Browser; origin: string }) => Promise<T>,
  args: string[] = [],
  executablePath?: string,
): Promise<T> {
  const server = await startPreview(web, await perfBuild());
  try {
    const browser = await chromium.launch({ args, ...(executablePath ? { executablePath } : {}) });
    try {
      return await run({ browser, origin: server.origin });
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}

/** `page.goto` until the preview server answers. */
export async function open(page: import("@playwright/test").Page, url: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(url);
      return;
    } catch (error) {
      if (attempt > 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
