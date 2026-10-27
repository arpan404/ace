import { execFile, spawnSync } from "node:child_process";
import { closeSync, openSync, renameSync } from "node:fs";
import { once } from "node:events";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { GitService, spawnGitProcess } from "./index.ts";
import { junctionInPlace } from "./junction-test-fixtures.ts";
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

/** A local Git origin that accepts connections and never answers. */
async function silentOrigin() {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No origin port");
  return {
    url: `http://127.0.0.1:${address.port}/project.git`,
    connected: () => sockets.size > 0,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function committedSource(base: string): Promise<string> {
  const source = join(base, "source");
  await mkdir(source);
  await git(source, "init", "--initial-branch=trunk");
  await writeFile(join(source, "README.md"), "first\n");
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
  return `file:///${source.replaceAll("\\", "/")}`;
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
      expect(info.root).toBe(target);
      expect(info.branch).toBe("trunk");
    } finally {
      await service.close();
    }
    expect(await exists(join(target, "README.md"))).toBe(true);
  });

  test("an empty held folder can't be turned into a junction while Git starts init in it", async () => {
    const base = await scratch();
    const project = join(base, "empty project");
    const decoy = join(base, "decoy");
    await mkdir(project);
    await mkdir(decoy);
    let converted: boolean | undefined;
    const service = new GitService({
      processRuntime: {
        spawn: (command, args, options) => {
          // The last moment before Git opens its working directory by path.
          if (args.includes("init")) converted = junctionInPlace(project, decoy);
          return spawnGitProcess(command, args, options);
        },
      },
    });
    try {
      await held(project, (fd) => service.init(project, "main", fd));
    } finally {
      await service.close();
    }
    expect(converted).toBe(false);
    expect(await exists(join(project, ".git", "HEAD"))).toBe(true);
    expect(await exists(join(decoy, ".git"))).toBe(false);
  });

  test("a held folder can't be renamed while Git works in it, and can be afterwards", async () => {
    const base = await scratch();
    const project = join(base, "project");
    await mkdir(project);
    let renamed: unknown;
    const service = new GitService({
      processRuntime: {
        spawn: (command, args, options) => {
          if (args.includes("init"))
            try {
              renameSync(project, join(base, "moved"));
              renamed = true;
            } catch (error) {
              renamed = error;
            }
          return spawnGitProcess(command, args, options);
        },
      },
    });
    try {
      await held(project, (fd) => service.init(project, "main", fd));
    } finally {
      await service.close();
    }
    expect(renamed).toMatchObject({ code: expect.stringMatching(/^(EPERM|EBUSY|EACCES)$/) });
    expect(await exists(join(project, ".git", "HEAD"))).toBe(true);
    await rename(project, join(base, "moved"));
    expect(await exists(join(base, "moved", ".git", "HEAD"))).toBe(true);
  });

  test("Git in a held network-share folder is confined or refused plainly", async (context) => {
    const local = await scratch();
    const share = `\\\\localhost\\${local.slice(0, 1)}$${local.slice(2)}`;
    if (!(await exists(share))) context.skip("no administrative share on this machine");
    const project = join(share, "shared project");
    await mkdir(project);
    const service = new GitService();
    try {
      const outcome = await held(project, (fd) => service.init(project, "main", fd)).then(
        () => "initialized",
        (error: unknown) => error,
      );
      if (outcome === "initialized")
        expect(await exists(join(local, "shared project", ".git", "HEAD"))).toBe(true);
      else
        expect(outcome).toMatchObject({
          code: "unsupported_repository",
          message: expect.stringContaining("network folder"),
        });
    } finally {
      await service.close();
    }
  });
  test("a held clone stopped while its origin never answers leaves the folder usable at once", async () => {
    const base = await scratch();
    const source = await committedSource(base);
    const origin = await silentOrigin();
    const target = join(base, "project");
    await mkdir(target);
    // No waiting at admission: the stopped clone's lease must already be gone.
    const service = new GitService({ transportProtocols: ["http", "file"], leaseWaitMs: 0 });
    try {
      const stopped = await held(target, (fd) =>
        service.clone(
          {
            parent: base,
            path: target,
            url: origin.url,
            directoryFd: fd,
            signal: new AbortController().signal,
            progress: () => undefined,
            transfer: { timeoutMs: 3000 },
          },
          { validateUrl: () => undefined, protocols: ["http"] },
        ),
      ).catch((error: unknown) => error);
      expect(stopped).toMatchObject({ code: "git_timeout" });
      expect(origin.connected()).toBe(true);
      // The folder stays held until the stopped Git is gone; then it can be removed.
      await rm(target, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
      await mkdir(target);
      await held(target, (fd) =>
        service.clone(
          {
            parent: base,
            path: target,
            url: source,
            directoryFd: fd,
            signal: new AbortController().signal,
            progress: () => undefined,
          },
          { validateUrl: () => undefined, protocols: ["file"] },
        ),
      );
    } finally {
      await service.close();
      await origin.close();
    }
    expect(await exists(join(target, "README.md"))).toBe(true);
  });

  test("a held clone whose stopped Git ace couldn't contain keeps its folder blocked", async () => {
    const base = await scratch();
    const origin = await silentOrigin();
    const target = join(base, "project");
    await mkdir(target);
    const hidden: { child: ReturnType<typeof spawnGitProcess>; pid: number }[] = [];
    const service = new GitService({
      transportProtocols: ["http"],
      leaseWaitMs: 0,
      processRuntime: {
        spawn: (command, args, options) => {
          const child = spawnGitProcess(command, args, options);
          // A fetch ace can't name a process for never joins a job: nothing proves it ended.
          if (args.includes("fetch")) {
            if (child.pid) hidden.push({ child, pid: child.pid });
            Object.defineProperty(child, "pid", { value: undefined });
          }
          return child;
        },
      },
    });
    try {
      const clone = () =>
        held(target, (fd) =>
          service.clone(
            {
              parent: base,
              path: target,
              url: origin.url,
              directoryFd: fd,
              signal: new AbortController().signal,
              progress: () => undefined,
              transfer: { timeoutMs: 3000 },
            },
            { validateUrl: () => undefined, protocols: ["http"] },
          ),
        );
      expect(await clone().catch((error: unknown) => error)).toMatchObject({
        code: "git_timeout",
      });
      expect(await service.mutationState(target)).toMatchObject({ status: "quarantined" });
      expect(await clone().catch((error: unknown) => error)).toMatchObject({
        code: "git_quarantined",
      });
    } finally {
      // The uncontained fetch is still running in the folder: end it before the folder goes.
      await Promise.all(
        hidden.map(({ child, pid }) => {
          if (child.exitCode !== null || child.signalCode !== null) return undefined;
          const exited = once(child, "exit");
          spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
          return exited;
        }),
      );
      await origin.close();
      await service.close();
    }
  });
});
