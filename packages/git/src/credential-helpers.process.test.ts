import { access, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { GitService, type GitOptions } from "./index.ts";
import { repository, scalar, execute } from "./test-repo.ts";
import { executableAskpass, challengeRemote, helper } from "./credential-test-fixtures.ts";

async function poison(repo: string, url: string, scope: "local" | "worktree") {
  if (scope === "worktree") await scalar(repo, "config", "extensions.worktreeConfig", "true");
  const generic = await helper(repo, "repo-helper");
  const scoped = await helper(repo, "url-helper");
  const askpass = await executableAskpass(dirname(repo), "repo-askpass");
  for (const [key, command] of [
    ["credential.helper", `!${generic.command}`],
    [`credential.${url}.helper`, `!${scoped.command}`],
    ["core.askPass", askpass.path],
  ]) {
    if (key === undefined || command === undefined) throw new Error("Missing poison fixture");
    await scalar(repo, "config", `--${scope}`, key, command);
  }
  return [generic.marker, scoped.marker, askpass.marker];
}

async function absent(markers: string[]) {
  for (const marker of markers)
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
}

async function transfer(service: GitService, repo: string, operation: "push" | "fetch") {
  if (operation === "push") return service.push({ worktree: repo, remote: "origin" });
  return service.fetchBranch({
    repo,
    remote: "origin",
    branch: await scalar(repo, "symbolic-ref", "--short", "HEAD"),
    timeoutMs: 10_000,
  });
}

test.each([
  ["push", "local"],
  ["push", "worktree"],
  ["fetch", "local"],
  ["fetch", "worktree"],
] as const)(
  "authorized %s never executes %s helpers, URL helpers or askpass on an HTTP challenge",
  async (operation, scope) => {
    const repo = await repository();
    const remote = await challengeRemote();
    const service = new GitService({ credentialHelperLookup: async () => [] });
    try {
      await scalar(repo, "remote", "add", "origin", remote.url);
      const markers = await poison(repo, remote.url, scope);
      service.protectWorktree(repo);
      await expect(transfer(service, repo, operation)).rejects.toMatchObject({ name: "GitError" });
      expect(remote.requests()).toBeGreaterThan(0);
      expect(remote.authenticated()).toBe(false);
      await absent(markers);
    } finally {
      await service.close();
      await remote.close();
    }
  },
);

test.each(["generic", "URL-scoped"])(
  "an injected global %s helper authenticates an authorized push while repository commands remain blocked",
  async (kind) => {
    const repo = await repository();
    const remote = await challengeRemote();
    const trusted = await helper(
      repo,
      "user-helper",
      "username=test-user\npassword=test-password\n",
    );
    const service = new GitService({
      credentialHelperLookup: async (scope) =>
        scope === "global"
          ? [
              {
                key: kind === "generic" ? "credential.helper" : `credential.${remote.url}.helper`,
                value: `!${trusted.command}`,
              },
            ]
          : [],
    });
    try {
      await scalar(repo, "remote", "add", "origin", remote.url);
      const markers = await poison(repo, remote.url, "local");
      service.protectWorktree(repo);
      await expect(service.push({ worktree: repo, remote: "origin" })).rejects.toMatchObject({
        name: "GitError",
      });
      expect(remote.authenticated()).toBe(true);
      await expect(access(trusted.marker)).resolves.toBeUndefined();
      await absent(markers);
    } finally {
      await service.close();
      await remote.close();
    }
  },
);

test.each(["GIT_ASKPASS", "SSH_ASKPASS"])(
  "an authorized push never executes inherited %s during an HTTP challenge",
  async (variable) => {
    const repo = await repository();
    const remote = await challengeRemote();
    const askpass = await executableAskpass(dirname(repo), "inherited-askpass");
    const service = new GitService({ credentialHelperLookup: async () => [] });
    try {
      await scalar(repo, "remote", "add", "origin", remote.url);
      vi.stubEnv(variable, askpass.path);
      service.protectWorktree(repo);
      await expect(service.push({ worktree: repo, remote: "origin" })).rejects.toMatchObject({
        name: "GitError",
      });
      expect(remote.requests()).toBeGreaterThan(0);
      await absent([askpass.marker]);
    } finally {
      vi.unstubAllEnvs();
      await service.close();
      await remote.close();
    }
  },
);

test.each(["core.askPass", "GIT_ASKPASS", "SSH_ASKPASS"])(
  "the executable %s fixture runs on an HTTP challenge without the ace policy",
  async (selector) => {
    const repo = await repository();
    const remote = await challengeRemote();
    const askpass = await executableAskpass(dirname(repo), "control-askpass");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("GIT_") && key !== "SSH_ASKPASS",
      ),
    );
    env.GIT_TERMINAL_PROMPT = "0";
    try {
      await scalar(repo, "remote", "add", "origin", remote.url);
      if (selector === "core.askPass") await scalar(repo, "config", selector, askpass.path);
      else env[selector] = askpass.path;
      await expect(
        execute("git", ["-c", "credential.helper=", "push", "origin", "HEAD"], {
          cwd: repo,
          env,
          timeout: 10_000,
        }),
      ).rejects.toBeDefined();
      expect(remote.requests()).toBeGreaterThan(0);
      await expect(access(askpass.marker)).resolves.toBeUndefined();
    } finally {
      await remote.close();
    }
  },
);

test("authorized transfers restore helpers from real system/global files, including URL-scoped helpers, without reading repository helpers", async () => {
  const repo = await repository();
  const remote = await challengeRemote();
  const system = join(dirname(repo), "system-config");
  const global = join(dirname(repo), "global-config");
  await writeFile(system, "");
  await writeFile(global, "");
  const systemHelper = await helper(repo, "system-helper", "username=test-user\n");
  const globalHelper = await helper(repo, "global-helper", "password=test-password\n");
  await scalar(repo, "config", "--file", system, "credential.helper", `!${systemHelper.command}`);
  await scalar(
    repo,
    "config",
    "--file",
    global,
    `credential.${remote.url}.helper`,
    `!${globalHelper.command}`,
  );
  const options: GitOptions = {
    credentialConfigPaths: { system, global, xdg: join(dirname(repo), "unused-xdg") },
  };
  const service = new GitService(options);
  try {
    await scalar(repo, "remote", "add", "origin", remote.url);
    const markers = await poison(repo, remote.url, "worktree");
    service.protectWorktree(repo);
    await expect(service.push({ worktree: repo, remote: "origin" })).rejects.toMatchObject({
      name: "GitError",
    });
    expect(remote.authenticated()).toBe(true);
    await expect(access(systemHelper.marker)).resolves.toBeUndefined();
    await expect(access(globalHelper.marker)).resolves.toBeUndefined();
    await absent(markers);
  } finally {
    await service.close();
    await remote.close();
  }
});
