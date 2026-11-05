import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { z } from "zod";
import { electronBundles } from "../../../scripts/common.ts";
import { packagedLayout, runMain } from "./testing/packaged-app.ts";

const Found = z.array(z.object({ id: z.string(), available: z.boolean(), detail: z.string() }));

/*
 * In `nodeOnlySuites`: the main process runs on Electron's Node, so the bundle runs on Node
 * here. Building it the way the app is built, and laying it out the way it is packaged, catches
 * a probe worker the app never ships or leaves inside the archive.
 */
test.runIf(process.platform !== "win32")(
  "the packaged main process finds the git on PATH through its own probe worker",
  async ({ onTestFinished }) => {
    const root = await mkdtemp(join(tmpdir(), "ace-desktop-toolchains-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const built = join(root, "dist");
    const [main, workers] = electronBundles(join(built, "app"), { ACE_VERSION: "0.0.0" });
    if (!main || !workers) throw new Error("The app's bundles changed shape");
    await build({
      ...main,
      entryPoints: {
        main: fileURLToPath(new URL("./testing/toolchains-main.ts", import.meta.url)),
      },
      logLevel: "silent",
    });
    await build({ ...workers, logLevel: "silent" });
    const entry = await packagedLayout(built, join(root, "Resources"));
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\necho 'git version 9.9.9'\n");
    await chmod(join(bin, "git"), 0o700);

    const tools = Found.parse(JSON.parse(await runMain(entry, { PATH: bin, HOME: root })));
    expect(tools.find((tool) => tool.id === "git")).toEqual({
      id: "git",
      available: true,
      detail: "git version 9.9.9",
    });
  },
);
