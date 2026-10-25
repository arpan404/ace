import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { atomicPointer, pointer } from "./index.ts";

test("Windows release pointers publish and replace regular files without symlink privileges", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-release-pointer-"));
  const path = join(root, "current");
  try {
    expect(await pointer(path, "win32")).toBeUndefined();
    await atomicPointer(path, "releases/1.0.0-linux-x64", "win32");
    expect(await pointer(path, "win32")).toBe("releases/1.0.0-linux-x64");
    await atomicPointer(path, "releases/1.1.0-linux-x64", "win32");
    expect(await readFile(path, "utf8")).toBe("releases/1.1.0-linux-x64");
    expect(await pointer(path, "win32")).toBe("releases/1.1.0-linux-x64");
    await expect(atomicPointer(path, "../../outside", "win32")).rejects.toThrow();
    expect(await pointer(path, "win32")).toBe("releases/1.1.0-linux-x64");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows release pointers refuse malformed, oversized and directory contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-release-pointer-invalid-"));
  const path = join(root, "current");
  try {
    for (const contents of ["../../outside", "releases/1.0.0-linux-x64\nextra", "x".repeat(513)]) {
      await writeFile(path, contents);
      await expect(pointer(path, "win32")).rejects.toThrow();
    }
    await rm(path);
    await mkdir(path);
    await expect(pointer(path, "win32")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
