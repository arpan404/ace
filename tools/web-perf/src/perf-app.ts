import { chromium, type Browser } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { stopProcess } from "@ace/perf-kit";

/*
 * The production build in `--mode perf` (ADR 0056), served by `vite preview` and opened in
 * Chromium: its client worker is fed by the endless agent (`?rate=` events/s, `?history=`
 * items of older history). Shared by the main-thread and the memory budgets.
 */

const web = new URL("../../../apps/web/", import.meta.url).pathname;
const requireWeb = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const vite = join(dirname(requireWeb.resolve("vite/package.json")), "bin/vite.js");

export async function withPerfApp<T>(
  port: number,
  run: (app: { browser: Browser; origin: string }) => Promise<T>,
  args: string[] = [],
  executablePath?: string,
): Promise<T> {
  const out = mkdtempSync(join(tmpdir(), "ace-web-perf-"));
  let server: ReturnType<typeof spawn> | undefined;
  try {
    execFileSync("bunx", ["vite", "build", "--mode", "perf", "--outDir", out, "--emptyOutDir"], {
      cwd: web,
      stdio: ["ignore", "ignore", "inherit"],
    });
    server = spawn(
      process.execPath,
      [
        vite,
        "preview",
        "--outDir",
        out,
        "--port",
        String(port),
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      { cwd: web, stdio: "ignore" },
    );
    const browser = await chromium.launch({ args, ...(executablePath ? { executablePath } : {}) });
    try {
      return await run({ browser, origin: `http://127.0.0.1:${port}` });
    } finally {
      await browser.close();
    }
  } finally {
    if (server) await stopProcess(server);
    rmSync(out, { recursive: true, force: true });
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
