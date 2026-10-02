import { mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checked, hashFile, runProcess } from "@ace/service";
import { z } from "zod";
const target = z.enum(["linux-x64", "linux-arm64"]).parse(process.argv[2]);
if (target !== `${process.platform}-${process.arch}`)
  throw new Error("Native prebuilds must run on their Linux target host");
const output = resolve(process.argv[3] ?? join(import.meta.dirname, "../dist/native"));
const packageRoot = resolve(import.meta.dirname, "../node_modules/node-pty");
const packageJson = z
  .object({ version: z.literal("1.1.0") })
  .parse(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")));
void packageJson;
const compiler = await checked(runProcess, "c++", ["--version"]);
await checked(runProcess, process.execPath, [
  resolve(import.meta.dirname, "../node_modules/node-gyp/bin/node-gyp.js"),
  "rebuild",
  `--directory=${packageRoot}`,
  "--target=24.13.0",
  `--arch=${process.arch}`,
]);
const directory = join(output, target);
await mkdir(directory, { recursive: true });
const pty = join(directory, "pty.node"),
  helper = join(directory, "spawn-helper");
await cp(join(packageRoot, "build/Release/pty.node"), pty);
await cp(join(packageRoot, "build/Release/spawn-helper"), helper);
await writeFile(
  join(directory, "provenance.json"),
  JSON.stringify({
    node: "24.13.0",
    nodePty: "1.1.0",
    nodeGyp: "11.5.0",
    compiler: compiler.stdout,
  }) + "\n",
);
await writeFile(
  join(output, `${target}.json`),
  JSON.stringify({
    [target]: { pty, helper, ptySha256: await hashFile(pty), helperSha256: await hashFile(helper) },
  }) + "\n",
);
