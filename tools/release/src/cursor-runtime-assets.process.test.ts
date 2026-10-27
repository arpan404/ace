import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { stageCursorRuntime } from "./cursor-runtime-assets.ts";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const sdk = join(repo, "packages/adapter-cursor/node_modules/@cursor/sdk");
// The SDK's direct runtime dependencies; each must ship beside it or its import fails.
const dependencies = [
  "@bufbuild/protobuf",
  "@connectrpc/connect",
  "@connectrpc/connect-web",
  "@statsig/js-client",
  "zod",
];

async function staged(target: string, check: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ace-cursor-runtime-"));
  try {
    await stageCursorRuntime(sdk, root, target);
    await check(join(root, "node_modules"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function packageName(root: string, name: string) {
  return JSON.parse(await readFile(join(root, name, "package.json"), "utf8")).name;
}

// Bun installs `@cursor/sdk-win32-x64` only for `--os=win32 --cpu=x64`, as x64 Windows CI does.
test.runIf(process.platform === "win32" && process.arch === "x64")(
  "a Windows x64 package ships the Cursor SDK, its dependencies and the x64 ripgrep helper",
  async () => {
    await staged("win32-x64", async (modules) => {
      expect(await packageName(modules, "@cursor/sdk")).toBe("@cursor/sdk");
      for (const name of dependencies) expect(await packageName(modules, name)).toBe(name);
      expect((await stat(join(modules, "@cursor/sdk-win32-x64/bin/rg.exe"))).isFile()).toBe(true);
    });
  },
);

test("a Windows ARM64 package ships the Cursor SDK and its dependencies without any helper", async () => {
  await staged("win32-arm64", async (modules) => {
    expect(await packageName(modules, "@cursor/sdk")).toBe("@cursor/sdk");
    for (const name of dependencies) expect(await packageName(modules, name)).toBe(name);
    expect(existsSync(join(modules, "@cursor/sdk/dist"))).toBe(true);
    expect(await readdir(join(modules, "@cursor"))).toEqual(["sdk"]);
  });
});

test("a Windows target other than x64 or ARM64 is refused", async () => {
  await expect(stageCursorRuntime(sdk, tmpdir(), "win32-ia32")).rejects.toThrow(
    "Unsupported Cursor runtime target: win32-ia32",
  );
});
