import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { z } from "zod";
import { electronBundles } from "../../../scripts/common.ts";

const Found = z.array(z.object({ id: z.string(), available: z.boolean(), detail: z.string() }));

/*
 * In `nodeOnlySuites`: the main process runs on Electron's Node, so the bundle runs on Node
 * here. Building it the way the app is built catches a probe worker the bundle never ships.
 */
test.runIf(process.platform !== "win32")(
  "the bundled main process finds the git on PATH through its own probe worker",
  async ({ onTestFinished }) => {
    const root = await mkdtemp(join(tmpdir(), "ace-desktop-toolchains-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const app = join(root, "app");
    const [main, workers] = electronBundles(app, { ACE_VERSION: "0.0.0" });
    if (!main || !workers) throw new Error("The app's bundles changed shape");
    await build({
      ...main,
      entryPoints: { main: new URL("./testing/toolchains-main.ts", import.meta.url).pathname },
      logLevel: "silent",
    });
    await build({ ...workers, logLevel: "silent" });
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\necho 'git version 9.9.9'\n");
    await chmod(join(bin, "git"), 0o700);

    const child = spawn(process.execPath, [join(app, "main.mjs")], {
      env: { PATH: bin, HOME: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    const [code] = await once(child, "close");
    expect(code, Buffer.concat(errors).toString()).toBe(0);
    const tools = Found.parse(JSON.parse(Buffer.concat(output).toString()));
    expect(tools.find((tool) => tool.id === "git")).toEqual({
      id: "git",
      available: true,
      detail: "git version 9.9.9",
    });
  },
);
