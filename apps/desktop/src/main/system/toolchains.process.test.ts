import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { z } from "zod";
import { asarUnpacked, electronBundles } from "../../../scripts/common.ts";

const Found = z.array(z.object({ id: z.string(), available: z.boolean(), detail: z.string() }));

/**
 * The built app laid out as electron-builder packages it: everything in `app.asar` (a plain
 * folder here, which Node can read and a worker loading from it must not need), except what
 * `asarUnpacked` moves to `app.asar.unpacked`. Returns the packaged main entry.
 */
async function packagedLayout(built: string, resources: string): Promise<string> {
  for (const file of await readdir(built, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const relative = join(file.parentPath, file.name).slice(built.length + 1);
    const unpacked = asarUnpacked.some((pattern) => matchesGlob(relative, pattern));
    const target = join(resources, unpacked ? "app.asar.unpacked" : "app.asar", relative);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(built, relative), target);
  }
  return join(resources, "app.asar", "main.mjs");
}

/** Runs `main` on this Node and returns its stdout; fails with its stderr if it hangs or fails. */
async function runMain(main: string, env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn(process.execPath, [main], { env, stdio: ["ignore", "pipe", "pipe"] });
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  let hung = false;
  const timer = setTimeout(() => {
    hung = true;
    child.kill("SIGKILL");
  }, 15_000);
  const [code] = await once(child, "close");
  clearTimeout(timer);
  const stderr = Buffer.concat(errors).toString();
  if (hung) throw new Error(`The bundled main process hung: ${stderr}`);
  expect(code, stderr).toBe(0);
  return Buffer.concat(output).toString();
}

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
    const built = join(root, "built");
    const [main, workers] = electronBundles(built, { ACE_VERSION: "0.0.0" });
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
