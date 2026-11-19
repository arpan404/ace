import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { z } from "zod";
import { electronBundles } from "../../../scripts/common.ts";
import { stageKoffi, stageMainProcessNatives } from "../../../scripts/koffi.ts";
import { packagedLayout, runMain } from "./testing/packaged-app.ts";

const Facts = z.object({ pid: z.number(), taskkill: z.string().optional() });
const Report = z.object({ pid: z.number(), main: Facts, worker: Facts });

const standIn = (name: string) => fileURLToPath(new URL(`./testing/${name}`, import.meta.url));

/*
 * In `nodeOnlySuites`: the main process runs on Electron's Node, which binds kernel32 through
 * koffi (Bun uses bun:ffi). The app is built with its own bundle options, staged by the build's
 * koffi step and packed through the package's own afterPack hook, so this fails if koffi is not
 * staged, not copied beside app.asar, or not reachable from main's bundle or from a worker in
 * app.asar.unpacked. On Windows it also resolves taskkill through the tree stop's own System32
 * lookup; on macOS and Linux it loads that platform's prebuilt binary, staged by the test.
 */
test("the packaged main process and its probe worker make native calls through koffi", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), "ace-desktop-koffi-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, "dist");
  const [main, workers] = electronBundles(join(dist, "app"), { ACE_VERSION: "0.0.0" });
  if (!main || !workers) throw new Error("The app's bundles changed shape");
  await build({ ...main, entryPoints: { main: standIn("koffi-main.ts") }, logLevel: "silent" });
  await build({
    ...workers,
    entryPoints: { "probe-worker": standIn("koffi-worker.ts") },
    logLevel: "silent",
  });
  // The build's own step stages koffi on Windows only; elsewhere the test stages it so the
  // same packed layout runs here, where nothing in the app calls it.
  await stageMainProcessNatives(dist, process.platform, process.arch);
  if (process.platform !== "win32")
    await stageKoffi(join(dist, "node_modules"), process.platform, process.arch);
  const entry = await packagedLayout(dist, join(root, "out"));

  const report = Report.parse(JSON.parse(await runMain(entry, { HOME: root })));
  expect(report.main.pid).toBe(report.pid);
  expect(report.worker.pid).toBe(report.pid);
  if (process.platform === "win32")
    for (const facts of [report.main, report.worker])
      expect(facts.taskkill?.toLowerCase()).toMatch(/^[a-z]:\\windows\\system32\\taskkill\.exe$/);
});
