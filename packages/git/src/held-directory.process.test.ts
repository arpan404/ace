import { execFile } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { GitService } from "./index.ts";
import { git, scratch } from "./test-repo.ts";

const run = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function held<T>(path: string, work: (fd: number) => Promise<T>): Promise<T> {
  const fd = openSync(path, "r");
  try {
    return await work(fd);
  } finally {
    closeSync(fd);
  }
}

async function vacantDrive(): Promise<string> {
  for (let code = 90; code >= 72; code -= 1) {
    const drive = `${String.fromCharCode(code)}:`;
    if (!(await exists(`${drive}\\`))) return drive;
  }
  throw new Error("No vacant drive letter");
}

describe.runIf(process.platform === "win32")("Windows Git in a held folder", () => {
  test("init lands in the held folder after its path is renamed and reused", async () => {
    const base = await scratch();
    const project = join(base, "project 雪");
    await mkdir(project);
    const service = new GitService();
    try {
      await held(project, async (fd) => {
        await rename(project, join(base, "moved"));
        await mkdir(project);
        await writeFile(join(project, "decoy.txt"), "decoy\n");
        await service.init(project, "main", fd);
      });
    } finally {
      await service.close();
    }
    expect(await exists(join(base, "moved", ".git"))).toBe(true);
    expect(await exists(join(project, ".git"))).toBe(false);
    expect((await git(join(base, "moved"), "log", "--format=%s")).toString().trim()).toBe(
      "Initialize ace project",
    );
  });

  test("a drive alias moved to another folder does not redirect Git for the held folder", async () => {
    const base = await scratch();
    const original = join(base, "original");
    const decoy = join(base, "decoy");
    await mkdir(original);
    await mkdir(decoy);
    const subst = join(z.string().parse(process.env.SystemRoot), "System32", "subst.exe");
    const drive = await vacantDrive();
    await run(subst, [drive, original]);
    const service = new GitService();
    try {
      await held(`${drive}\\`, async (fd) => {
        await run(subst, [drive, "/D"]);
        await run(subst, [drive, decoy]);
        await service.init(`${drive}\\`, "main", fd);
      });
    } finally {
      await run(subst, [drive, "/D"]).catch(() => undefined);
      await service.close();
    }
    expect(await exists(join(original, ".git"))).toBe(true);
    expect(await exists(join(decoy, ".git"))).toBe(false);
  });

  test("project facts and clone through a held folder name the folder's own checkout", async () => {
    const base = await scratch();
    const source = join(base, "source");
    await mkdir(source);
    await git(source, "init", "--initial-branch=trunk");
    await writeFile(join(source, "README.md"), "line one\r\nline two\n");
    await git(source, "add", "README.md");
    await git(
      source,
      "-c",
      "user.name=ace",
      "-c",
      "user.email=ace@localhost",
      "commit",
      "-m",
      "first",
    );
    const target = join(base, "Target Folder");
    await mkdir(target);
    const service = new GitService({ transportProtocols: ["file"] });
    try {
      const info = await held(target, async (fd) => {
        await service.clone(
          {
            parent: base,
            path: target,
            url: `file:///${source.replaceAll("\\", "/")}`,
            directoryFd: fd,
            signal: new AbortController().signal,
            progress: () => undefined,
          },
          { validateUrl: () => undefined, protocols: ["file"] },
        );
        return service.projectInfo(target, fd);
      });
      expect(info.root.toLowerCase()).toBe(target.toLowerCase());
      expect(info.branch).toBe("trunk");
    } finally {
      await service.close();
    }
    expect(await exists(join(target, "README.md"))).toBe(true);
  });
});
