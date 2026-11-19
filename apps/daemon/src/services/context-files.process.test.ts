// Reason: only a real ace-files proves a root mention lists a checkout. Its path check rejects
// `.` (the form a person's folder mention arrives in), so the daemon's translation to the empty
// path is the edge this covers; a fake lister would only restate the translation.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemFilesClock } from "@ace/files-native";
import { findFilesBinary, FilesTool } from "../files-tool/tool.ts";
import { contextFiles } from "./context.ts";

const exec = promisify(execFile);
const binary = findFilesBinary();

describe.skipIf(!binary)("a root folder mention", () => {
  const tool = new FilesTool({ binary, clock: systemFilesClock });
  let home = "";

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "ace-context-files-"));
  });

  afterAll(async () => {
    await tool.close();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("lists a git checkout and a plain folder from the checkout root", async () => {
    const checkout = join(home, "checkout");
    await mkdir(join(checkout, "src"), { recursive: true });
    await exec("git", ["init", "--quiet", checkout]);
    await writeFile(join(checkout, ".gitignore"), "ignored.txt\n");
    await writeFile(join(checkout, "README.md"), "# checkout\n");
    await writeFile(join(checkout, "ignored.txt"), "not mentioned\n");
    await writeFile(join(checkout, "src", "main.ts"), "export const main = 1;\n");

    const plain = join(home, "plain");
    await mkdir(join(plain, "notes"), { recursive: true });
    await writeFile(join(plain, "top.txt"), "top\n");
    await writeFile(join(plain, "notes", "nested.txt"), "nested\n");

    for (const [root, expected] of [
      [checkout, [".gitignore", "README.md", "src/main.ts"]],
      [plain, ["notes/nested.txt", "top.txt"]],
    ] as const) {
      const files: string[] = [];
      for await (const entry of contextFiles(tool, root, ".")) files.push(entry.path);
      expect(files.toSorted()).toEqual([...expected]);
    }
  });
});
