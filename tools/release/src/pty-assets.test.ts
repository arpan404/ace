import { expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import { stagePtyFiles } from "./pty-assets.ts";

async function fixtureSource(root: string): Promise<string> {
  const source = join(root, "node-pty");
  await mkdir(join(source, "lib/worker"), { recursive: true });
  await mkdir(join(source, "lib/shared"), { recursive: true });
  await mkdir(join(source, "prebuilds/win32-x64/conpty"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "node-pty" }));
  await writeFile(join(source, "LICENSE"), "fixture license");
  await writeFile(join(source, "lib/index.js"), "module.exports = {};");
  await writeFile(
    join(source, "lib/worker/conoutSocketWorker.js"),
    'module.exports = { marker: "conout-worker-fixture" };',
  );
  await writeFile(
    join(source, "lib/shared/conout.js"),
    "exports.getWorkerPipeName = (name) => name + '-worker';",
  );
  await writeFile(join(source, "prebuilds/win32-x64/conpty.node"), "fake conpty module");
  await writeFile(join(source, "prebuilds/win32-x64/conpty/conpty.dll"), "fake dll");
  // Files the Dll backend never loads must not leak into the staged closure.
  await writeFile(join(source, "prebuilds/win32-x64/winpty.dll"), "fallback");
  await writeFile(join(source, "prebuilds/win32-x64/conpty.pdb"), "symbols");
  await writeFile(join(source, "prebuilds/win32-x64/conpty/OpenConsole.exe"), "demo");
  return source;
}

test("windows staging preserves native bytes and runs the output workers", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-pty-win-"));
  try {
    const source = await fixtureSource(root);
    const destination = join(root, "staged/node-pty");
    await stagePtyFiles(source, destination, "win32-x64");
    const modulePath = join(destination, "prebuilds/win32-x64/conpty.node");
    // The native loader resolves the dll relative to its module
    // (`conpty\\conpty.dll` beside `conpty.node` in `src/win/conpty.cc`).
    const dllPath = join(dirname(modulePath), "conpty/conpty.dll");
    expect(await readFile(modulePath, "utf8")).toBe("fake conpty module");
    expect(await readFile(dllPath, "utf8")).toBe("fake dll");
    expect(await readFile(join(destination, "LICENSE"), "utf8")).toBe("fixture license");
    const require = createRequire(join(destination, "package.json"));
    expect(require(join(destination, "lib/worker/conoutSocketWorker.js"))).toEqual({
      marker: "conout-worker-fixture",
    });
    const conout = z
      .object({
        getWorkerPipeName: z.function({ input: [z.string()], output: z.string() }),
      })
      .parse(require(join(destination, "lib/shared/conout.js")));
    expect(conout.getWorkerPipeName("pipe")).toBe("pipe-worker");
    const staged = await readdir(join(destination, "prebuilds/win32-x64"));
    expect(staged.toSorted()).toEqual(["conpty", "conpty.node"]);
    expect(await readdir(join(destination, "prebuilds/win32-x64/conpty"))).toEqual(["conpty.dll"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { name: "dll", keepModule: true },
  { name: "module", keepModule: false },
] as const)("windows staging fails closed without the ConPTY $name", async ({ keepModule }) => {
  const root = await mkdtemp(join(tmpdir(), "ace-pty-win-missing-"));
  try {
    const source = join(root, "node-pty");
    await mkdir(join(source, "lib/worker"), { recursive: true });
    await mkdir(join(source, "lib/shared"), { recursive: true });
    await mkdir(join(source, "prebuilds/win32-x64/conpty"), { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "node-pty" }));
    await writeFile(join(source, "LICENSE"), "fixture license");
    await writeFile(join(source, "lib/worker/conoutSocketWorker.js"), "module.exports = {};");
    await writeFile(join(source, "lib/shared/conout.js"), "module.exports = {};");
    if (keepModule) await writeFile(join(source, "prebuilds/win32-x64/conpty.node"), "fake");
    else await writeFile(join(source, "prebuilds/win32-x64/conpty/conpty.dll"), "fake");
    await expect(stagePtyFiles(source, join(root, "out"), "win32-x64")).rejects.toThrow(
      /ConPTY|conpty/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("windows staging fails closed without the conout worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-pty-win-worker-"));
  try {
    const source = join(root, "node-pty");
    await mkdir(join(source, "lib/worker"), { recursive: true });
    await mkdir(join(source, "prebuilds/win32-x64/conpty"), { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "node-pty" }));
    await writeFile(join(source, "LICENSE"), "fixture license");
    await writeFile(join(source, "prebuilds/win32-x64/conpty.node"), "fake");
    await writeFile(join(source, "prebuilds/win32-x64/conpty/conpty.dll"), "fake");
    await expect(stagePtyFiles(source, join(root, "out"), "win32-x64")).rejects.toThrow(
      /worker|ConPTY/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
