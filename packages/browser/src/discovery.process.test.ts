import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installChromium, type ProcessSpawner } from "./index.ts";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function installation(output?: string) {
  const home = await mkdtemp(join(tmpdir(), "ace-browser-install-"));
  homes.push(home);
  const executable = join(home, "chromium", "fixture-chromium");
  const spawnProcess: ProcessSpawner = (_command, args, options) => {
    const script = args.includes("install")
      ? `require('node:fs').writeFileSync(process.argv[1], 'installed-by-fixture', {mode:0o700})`
      : `const fs=require('node:fs');
         if(fs.readFileSync(process.argv[1],'utf8')!=='installed-by-fixture')process.exit(1);
         process.stdout.write(Buffer.from(process.argv[2], 'base64'));`;
    return spawn(
      process.execPath,
      [
        "--input-type=commonjs",
        "-e",
        script,
        executable,
        Buffer.from(output ?? executable).toString("base64"),
      ],
      options,
    );
  };
  return { home, executable, spawnProcess };
}

it("installs an executable before the injected cache process can find it", async () => {
  const f = await installation();
  const path = await installChromium(f.home, f.spawnProcess);
  expect(path).toBe(f.executable);
  expect(await readFile(path, "utf8")).toBe("installed-by-fixture");
});

it.each(["x".repeat(9000), "/chrome\nforged", "/chrome\0forged"])(
  "rejects oversized or ambiguous cache process output %#",
  async (output) => {
    const f = await installation(output);
    await expect(installChromium(f.home, f.spawnProcess)).rejects.toThrow("cache lookup failed");
    expect(await readFile(f.executable, "utf8")).toBe("installed-by-fixture");
  },
);

it("rejects a failed installer without reporting a cached executable", async () => {
  const f = await installation();
  await expect(
    installChromium(f.home, (_command, args, options) =>
      args.includes("install")
        ? spawn(process.execPath, ["-e", "process.exit(1)"], options)
        : f.spawnProcess(_command, args, options),
    ),
  ).rejects.toThrow("Chromium install exited 1");
  await expect(readFile(f.executable)).rejects.toMatchObject({ code: "ENOENT" });
});
