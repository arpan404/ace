import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { TestContext } from "vitest";
import { openRoot, type Descriptor } from "./descriptor.ts";
import { PassDirectories } from "./pass-directories.ts";

async function folders({ onTestFinished }: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "ace-pass-directories-"));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  const outside = join(base, "outside");
  await mkdir(join(root, "a", "b"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, "a", "b", "file"), "inside");
  const pass = new PassDirectories(openRoot(root));
  onTestFinished(() => pass.close());
  return { root, outside, pass };
}
async function text(handle: Descriptor) {
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString();
  } finally {
    await handle.close();
  }
}

test.runIf(process.platform === "win32")(
  "a pass never reads through a held folder after it moves out of the project",
  async (context) => {
    const { root, outside, pass } = await folders(context);
    expect(await text(pass.file("a/b/file"))).toBe("inside");
    // The pass still holds a/b; Windows lets that folder itself move, and the handle follows it.
    await rename(join(root, "a", "b"), join(outside, "b"));
    await writeFile(join(outside, "b", "file"), "OUTSIDE SECRET");
    expect(() => pass.file("a/b/file")).toThrow();
    // A held folder's new child would open through the moved handle too.
    await mkdir(join(outside, "b", "c"));
    await writeFile(join(outside, "b", "c", "file"), "OUTSIDE SECRET");
    expect(() => pass.file("a/b/c/file")).toThrow();
    // Back in its place, the same folder serves reads again.
    await writeFile(join(outside, "b", "file"), "inside");
    await rename(join(outside, "b"), join(root, "a", "b"));
    expect(await text(pass.file("a/b/file"))).toBe("inside");
    expect(await readFile(join(root, "a", "b", "file"), "utf8")).toBe("inside");
  },
);

test.runIf(process.platform === "win32")(
  "a pass that has ended opens nothing, not even through folders it held",
  async (context) => {
    const { root, pass } = await folders(context);
    await writeFile(join(root, "top"), "inside");
    expect(await text(pass.file("a/b/file"))).toBe("inside");
    await pass.close();
    expect(() => pass.file("a/b/file")).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(() => pass.file("top")).toThrow(expect.objectContaining({ code: "EBADF" }));
  },
);
