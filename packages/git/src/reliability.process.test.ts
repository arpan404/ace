import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { GitService, spawnGitProcess } from "./index.ts";
import { git, proxyGit, repository, scratch } from "./test-repo.ts";

const services: GitService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});
function own(options: ConstructorParameters<typeof GitService>[0] = {}) {
  const service = new GitService(options);
  services.push(service);
  return service;
}

test("cancelling a clone fences its partial checkout while sibling projects remain usable", async () => {
  const parent = await scratch();
  const destination = join(parent, "partial");
  const sibling = join(parent, "sibling");
  await mkdir(sibling);
  await git(parent, "init", "-b", "main");
  const controller = new AbortController();
  const binary = await proxyGit(
    `if (args.includes('clone')) { process.stderr.write('ready\\n'); setInterval(()=>{},1000); return; }`,
  );
  const service = own({
    gitBinary: binary,
    processRuntime: {
      spawn(command, args, options) {
        const child = spawnGitProcess(command, args, options);
        if (args.includes("clone")) child.stderr.once("data", () => controller.abort());
        return child;
      },
    },
  });
  await expect(
    service.clone({
      parent,
      path: destination,
      url: "https://example.invalid/repo",
      signal: controller.signal,
      progress() {},
    }),
  ).rejects.toMatchObject({ code: "git_cancelled" });
  await expect(service.assertMutationAvailable(sibling)).resolves.toBeUndefined();
  await expect(service.assertMutationAvailable(parent)).resolves.toBeUndefined();
  await expect(service.mutationState(destination)).resolves.toMatchObject({
    status: "quarantined",
  });
});

test("worktree setup uses its longer deadline and a noninteractive push reaches its remote", async () => {
  const repo = await repository();
  const binary = await proxyGit(
    `if (args.includes('push') && (process.env.GCM_INTERACTIVE !== 'never' || !process.env.GIT_SSH_COMMAND.includes('BatchMode=yes'))) process.exit(88);`,
  );
  let setup = false;
  const service = own({
    gitBinary: binary,
    processRuntime: {
      spawn(command, args, options) {
        setup = args.includes("ace-worktree-setup");
        return spawnGitProcess(command, args, options);
      },
      scheduleTimeout(callback, milliseconds) {
        if (setup && milliseconds <= 30_000) {
          queueMicrotask(callback);
          return () => {};
        }
        const timer = setTimeout(callback, milliseconds);
        return () => clearTimeout(timer);
      },
    },
  });
  await service.setupWorktree({ worktree: repo, command: "printf ready > setup-result" });
  expect(await readFile(join(repo, "setup-result"), "utf8")).toBe("ready");
  const remote = join(await scratch(), "remote.git");
  await git(repo, "init", "--bare", remote);
  await git(repo, "remote", "add", "origin", remote);
  await service.push({ worktree: repo, remote: "origin" });
  expect(await git(remote, "rev-parse", "main")).toEqual(await git(repo, "rev-parse", "HEAD"));
});

test("background change counts report tracked and untracked edits without writing objects or the index", async () => {
  const repo = await repository();
  await writeFile(join(repo, "tracked.txt"), "changed\nanother\n");
  await writeFile(join(repo, "untracked"), "new\n");
  const index = await readFile(join(repo, ".git", "index"));
  const objects = await readdir(join(repo, ".git", "objects"), { recursive: true });
  expect(await own().changeSummary(repo)).toEqual({ files: 2, additions: 2, deletions: 1 });
  expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
  expect(await readdir(join(repo, ".git", "objects"), { recursive: true })).toEqual(objects);
});

test("ignored directory checks return a dirty checkout without enumerating dependency files", async () => {
  const repo = await repository();
  const path = join(await scratch(), "tree");
  const binary = await proxyGit(
    `if (args.includes('--ignored') && !args.includes('--directory')) { for (let n=0;n<65;n++) process.stdout.write('x'.repeat(1024*1024)); return; }`,
  );
  const service = own({ gitBinary: binary });
  await service.createWorktree({ repo, path, branch: "fixture", baseRef: "HEAD" });
  await mkdir(join(path, "ignored"));
  await writeFile(join(path, "ignored", "dependency"), "kept");
  await expect(service.removeWorktree({ repo, path })).rejects.toMatchObject({
    code: "dirty_worktree",
  });
  expect(await service.mutationState(path)).toMatchObject({ status: "available" });
  expect(await readFile(join(path, "ignored", "dependency"), "utf8")).toBe("kept");
});
