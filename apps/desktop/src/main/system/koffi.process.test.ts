import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { z } from "zod";
import { electronBundles } from "../../../scripts/common.ts";
import { stageKoffi } from "../../../scripts/koffi.ts";
import { packagedLayout, runMain } from "./testing/packaged-app.ts";

const Facts = z.object({ pid: z.number(), taskkill: z.string().optional() });
const Report = z.object({ pid: z.number(), main: Facts, worker: Facts });

const standIn = (name: string) => fileURLToPath(new URL(`./testing/${name}`, import.meta.url));

/*
 * In `nodeOnlySuites`: the main process runs on Electron's Node, which binds kernel32 through
 * koffi (Bun uses bun:ffi). The app is built and staged the way the build does it and laid out
 * the way it is packaged, so this fails if koffi is not staged, not placed beside app.asar, or
 * not reachable from main's bundle or from a worker in app.asar.unpacked. On macOS and Linux it
 * loads that platform's prebuilt binary; on Windows it also resolves taskkill through the tree
 * stop's own System32 lookup.
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
  await stageKoffi(join(dist, "node_modules"), process.platform, process.arch);
  const entry = await packagedLayout(dist, join(root, "Resources"));

  const report = Report.parse(JSON.parse(await runMain(entry, { HOME: root })));
  expect(report.main.pid).toBe(report.pid);
  expect(report.worker.pid).toBe(report.pid);
  if (process.platform === "win32")
    for (const facts of [report.main, report.worker])
      expect(facts.taskkill?.toLowerCase()).toMatch(/^[a-z]:\\windows\\system32\\taskkill\.exe$/);
});

test("staging koffi for an architecture whose prebuilt binary is not installed fails", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), "ace-desktop-koffi-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const other = process.arch === "arm64" ? "x64" : "arm64";
  await expect(stageKoffi(join(root, "node_modules"), process.platform, other)).rejects.toThrow(
    `@koromix/koffi-${process.platform}-${other} is not installed`,
  );
});
