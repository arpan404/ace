import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, matchesGlob } from "node:path";
import { expect } from "vitest";
import { asarUnpacked, packagedBesideApp } from "../../../../scripts/common.ts";

/**
 * A built `dist/` laid out as electron-builder packages it. `app/` goes into `app.asar` (a plain
 * folder here, which Node can read and a worker loading from it must not need), except what
 * `asarUnpacked` moves to `app.asar.unpacked`; the `packagedBesideApp` folders are copied
 * beside it, as afterPack does. Returns the packaged main entry.
 */
export async function packagedLayout(dist: string, resources: string): Promise<string> {
  const app = join(dist, "app");
  for (const file of await readdir(app, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const relative = join(file.parentPath, file.name).slice(app.length + 1);
    const unpacked = asarUnpacked.some((pattern) => matchesGlob(relative, pattern));
    const target = join(resources, unpacked ? "app.asar.unpacked" : "app.asar", relative);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(app, relative), target);
  }
  for (const folder of packagedBesideApp)
    if (existsSync(join(dist, folder)))
      await cp(join(dist, folder), join(resources, folder), { recursive: true });
  return join(resources, "app.asar", "main.mjs");
}

/** Runs `main` on this Node and returns its stdout; fails with its stderr if it hangs or fails. */
export async function runMain(main: string, env: NodeJS.ProcessEnv): Promise<string> {
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
