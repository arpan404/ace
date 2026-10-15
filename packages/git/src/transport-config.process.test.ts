import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, repository, scalar } from "./test-repo.ts";
import { challengeRemote, helper, quote } from "./credential-test-fixtures.ts";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** An SSH command that records its arguments and fails, as an unreachable host would. */
async function recordingSsh(directory: string, name: string) {
  const log = join(directory, `${name}.log`);
  const path = join(directory, `${name}.sh`);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(log)}\nexit 255\n`, {
    mode: 0o755,
  });
  return { log, command: quote(path) };
}

/** Daemon-owned user config files, so tests never read the machine's own. */
async function userFiles(repo: string, global: string) {
  const home = dirname(repo);
  const path = join(home, "user-global-config");
  await writeFile(path, global);
  const system = join(home, "user-system-config");
  await writeFile(system, "");
  return { system, global: path, xdg: join(home, "absent-xdg") };
}

test("a push uses the checkout's own core.sshCommand in batch mode, as the person's Git would", async () => {
  const repo = await repository();
  const ssh = await recordingSsh(dirname(repo), "repo-ssh");
  await scalar(repo, "config", "core.sshCommand", ssh.command);
  await git(repo, "remote", "add", "origin", "ssh://git@example.invalid/octo/ace.git");
  const service = new GitService({ credentialConfigPaths: await userFiles(repo, "") });
  try {
    await expect(service.push({ worktree: repo, remote: "origin" })).rejects.toMatchObject({
      name: "GitError",
    });
    const argv = await readFile(ssh.log, "utf8");
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("example.invalid");
  } finally {
    await service.close();
  }
});

test("a protected checkout's own core.sshCommand is ignored; the person's global one is used", async () => {
  const repo = await repository();
  const agent = await recordingSsh(dirname(repo), "agent-ssh");
  const person = await recordingSsh(dirname(repo), "person-ssh");
  await scalar(repo, "config", "core.sshCommand", agent.command);
  await git(repo, "remote", "add", "origin", "ssh://git@example.invalid/octo/ace.git");
  const service = new GitService({
    credentialConfigPaths: await userFiles(
      repo,
      `[core]\n\tsshCommand = ${person.command.replaceAll('"', '\\"')}\n`,
    ),
  });
  service.protectWorktree(repo);
  try {
    await expect(service.push({ worktree: repo, remote: "origin" })).rejects.toMatchObject({
      name: "GitError",
    });
    expect(await readFile(person.log, "utf8")).toContain("BatchMode=yes");
    expect(await exists(agent.log)).toBe(false);
  } finally {
    await service.close();
  }
});

test("a credential helper in a file the person's config includes for this checkout authenticates a push", async () => {
  const repo = await repository();
  const remote = await challengeRemote();
  const trusted = await helper(repo, "work-helper", "username=work\npassword=work-secret\n");
  const included = join(dirname(repo), "work.gitconfig");
  await writeFile(included, `[credential]\n\thelper = ${JSON.stringify(`!${trusted.command}`)}\n`);
  const service = new GitService({
    credentialConfigPaths: await userFiles(
      repo,
      `[includeIf "gitdir:${dirname(repo)}/"]\n\tpath = ${included}\n`,
    ),
  });
  try {
    await scalar(repo, "remote", "add", "origin", remote.url);
    await expect(service.push({ worktree: repo, remote: "origin" })).rejects.toMatchObject({
      name: "GitError",
    });
    expect(remote.authenticated()).toBe(true);
    expect(await exists(trusted.marker)).toBe(true);
  } finally {
    await service.close();
    await remote.close();
  }
});

test.each([
  ["working tree", "included.gitconfig"],
  ["Git directory", ".git/included.gitconfig"],
])(
  "a credential helper from an included file inside the checkout's %s never runs",
  async (_place, relative) => {
    const repo = await repository();
    const remote = await challengeRemote();
    const planted = await helper(repo, "planted-helper", "username=x\npassword=y\n");
    const included = join(repo, relative);
    await writeFile(
      included,
      `[credential]\n\thelper = ${JSON.stringify(`!${planted.command}`)}\n`,
    );
    const service = new GitService({
      // Quoted: the fixture checkout's path has a newline in it.
      credentialConfigPaths: await userFiles(
        repo,
        `[include]\n\tpath = ${JSON.stringify(included)}\n`,
      ),
    });
    try {
      await scalar(repo, "remote", "add", "origin", remote.url);
      await expect(service.push({ worktree: repo, remote: "origin" })).rejects.toMatchObject({
        name: "GitError",
      });
      expect(remote.requests()).toBeGreaterThan(0);
      expect(remote.authenticated()).toBe(false);
      expect(await exists(planted.marker)).toBe(false);
    } finally {
      await service.close();
      await remote.close();
    }
  },
);

test("a remote probe reads through the push transport: the person's helper, and no prompt", async () => {
  const repo = await repository();
  const remote = await challengeRemote();
  const trusted = await helper(repo, "probe-helper", "username=me\npassword=secret\n");
  const service = new GitService({
    credentialConfigPaths: await userFiles(
      repo,
      `[credential]\n\thelper = ${JSON.stringify(`!${trusted.command}`)}\n`,
    ),
  });
  const bare = new GitService({
    transportProtocols: ["file"],
    credentialHelperLookup: async () => [],
  });
  try {
    await scalar(repo, "remote", "add", "origin", remote.url);
    await expect(service.probeRemote({ worktree: repo, remote: "origin" })).rejects.toMatchObject({
      name: "GitError",
    });
    expect(remote.authenticated()).toBe(true);
    const readable = join(dirname(repo), "readable.git");
    await git(repo, "init", "--bare", readable);
    await scalar(repo, "remote", "add", "readable", readable);
    await expect(bare.probeRemote({ worktree: repo, remote: "readable" })).resolves.toBeUndefined();
    await expect(bare.probeRemote({ worktree: repo, remote: "origin" })).rejects.toMatchObject({
      name: "GitError",
    });
  } finally {
    await service.close();
    await bare.close();
    await remote.close();
  }
});
