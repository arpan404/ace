import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { GitService, spawnGitProcess } from "./index.ts";
import { challengeRemote, helper } from "./credential-test-fixtures.ts";
import { repository, scalar } from "./test-repo.ts";

async function configFiles(repo: string) {
  const directory = dirname(repo);
  const home = join(directory, "home");
  const xdgHome = join(directory, "xdg");
  const paths = {
    system: join(directory, "system-config"),
    xdg: join(xdgHome, "git", "config"),
    global: join(home, ".gitconfig"),
  };
  await mkdir(home);
  await mkdir(dirname(paths.xdg), { recursive: true });
  for (const file of Object.values(paths)) await writeFile(file, "");
  return { paths, home, xdgHome };
}

test.each(["URL reset before generic helper", "URL helper before generic reset"])(
  "helper restoration preserves %s in user-file order",
  async (ordering) => {
    const repo = await repository();
    const remote = await challengeRemote();
    const { paths } = await configFiles(repo);
    const trusted = await helper(
      repo,
      "ordered-user-helper",
      "username=test-user\npassword=test-password\n",
    );
    const scoped = `credential.${remote.url}.helper`;
    if (ordering === "URL reset before generic helper") {
      await scalar(repo, "config", "--file", paths.global, "--add", scoped, "");
      await scalar(
        repo,
        "config",
        "--file",
        paths.global,
        "--add",
        "credential.helper",
        `!${trusted.command}`,
      );
    } else {
      await scalar(repo, "config", "--file", paths.global, "--add", scoped, `!${trusted.command}`);
      await scalar(repo, "config", "--file", paths.global, "--add", "credential.helper", "");
    }
    const service = new GitService({ credentialConfigPaths: paths });
    service.protectWorktree(repo);
    try {
      await scalar(repo, "remote", "add", "origin", remote.url);
      await expect(service.push({ worktree: repo, remote: "origin" })).rejects.toMatchObject({
        name: "GitError",
      });
      expect(remote.requests()).toBeGreaterThan(0);
      expect(remote.authenticated()).toBe(ordering === "URL reset before generic helper");
      if (ordering === "URL reset before generic helper")
        await expect(access(trusted.marker)).resolves.toBeUndefined();
      else await expect(access(trusted.marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await service.close();
      await remote.close();
    }
  },
);

test("the daemon resolves both XDG and home helpers when .gitconfig exists, restoring them after system helpers", async () => {
  const repo = await repository();
  const remote = await challengeRemote();
  const { paths, home, xdgHome } = await configFiles(repo);
  const system = await helper(repo, "system-user-helper", "username=old-system-user\n");
  const xdg = await helper(repo, "xdg-user-helper", "username=xdg-user\n");
  const global = await helper(repo, "home-user-helper", "password=test-password\n");
  await scalar(
    repo,
    "config",
    "--file",
    paths.system,
    "--add",
    "credential.helper",
    `!${system.command}`,
  );
  // Reset the system helper in the lower-priority global file. The home helper then adds
  // the missing password, so successful HTTP auth requires XDG-before-home ordering.
  await scalar(repo, "config", "--file", paths.xdg, "--add", "credential.helper", "");
  await scalar(
    repo,
    "config",
    "--file",
    paths.xdg,
    "--add",
    "credential.helper",
    `!${xdg.command}`,
  );
  await scalar(
    repo,
    "config",
    "--file",
    paths.global,
    "--add",
    "credential.helper",
    `!${global.command}`,
  );
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", xdgHome);
  // Supply only the system file: global paths must come from the daemon's home/XDG resolver.
  const service = new GitService({ credentialConfigPaths: { system: paths.system } });
  service.protectWorktree(repo);
  try {
    await scalar(repo, "remote", "add", "origin", remote.url);
    await expect(service.push({ worktree: repo, remote: "origin" })).rejects.toMatchObject({
      name: "GitError",
    });
    expect(remote.authenticated()).toBe(true);
    await expect(access(xdg.marker)).resolves.toBeUndefined();
    await expect(access(global.marker)).resolves.toBeUndefined();
    await expect(access(system.marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.unstubAllEnvs();
    await service.close();
    await remote.close();
  }
});

test("system helper discovery resolves the installed Git's config origin before restoring the helper from its explicit file", async () => {
  const repo = await repository();
  const remote = await challengeRemote();
  const { paths } = await configFiles(repo);
  const trusted = await helper(
    repo,
    "installed-system-helper",
    "username=test-user\npassword=test-password\n",
  );
  const hostile = await helper(repo, "repository-helper");
  await scalar(repo, "config", "--file", paths.system, "credential.helper", `!${trusted.command}`);
  await scalar(repo, "config", "credential.helper", `!${hostile.command}`);
  const service = new GitService({
    credentialConfigPaths: { xdg: paths.xdg, global: paths.global },
    processRuntime: {
      // Isolate the installed Git's system file at the real process boundary.
      spawn: (command, args, options) =>
        spawnGitProcess(command, args, {
          ...options,
          env: { ...options.env, GIT_CONFIG_SYSTEM: paths.system },
        }),
    },
  });
  service.protectWorktree(repo);
  try {
    await scalar(repo, "remote", "add", "origin", remote.url);
    await expect(service.push({ worktree: repo, remote: "origin" })).rejects.toMatchObject({
      name: "GitError",
    });
    expect(remote.authenticated()).toBe(true);
    await expect(access(trusted.marker)).resolves.toBeUndefined();
    await expect(access(hostile.marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await service.close();
    await remote.close();
  }
});
