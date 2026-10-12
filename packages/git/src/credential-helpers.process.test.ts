import { access, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { GitService, spawnGitProcess, type GitOptions } from "./index.ts";
import { repository, scalar } from "./test-repo.ts";

const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";

async function challengeRemote() {
  let requests = 0;
  let authenticated = false;
  const server = createServer((request, response) => {
    requests++;
    if (request.headers.authorization) {
      authenticated = true;
      // We only need a real HTTP authentication exchange, not a smart Git server.
      response.writeHead(403);
    } else response.writeHead(401, { "WWW-Authenticate": 'Basic realm="git-test"' });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
  return {
    url: `http://127.0.0.1:${address.port}/repo.git`,
    requests: () => requests,
    authenticated: () => authenticated,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function helper(repo: string, name: string, fields: string = "") {
  const marker = join(dirname(repo), `${name}-executed`);
  const script = join(dirname(repo), `${name}.cjs`);
  await writeFile(
    script,
    `
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');
    process.stdin.resume();
    process.stdin.on('end', () => {
      if (process.argv.at(-1) === 'get') process.stdout.write(${JSON.stringify(fields)});
    });
  `,
  );
  return { marker, command: `${quote(process.execPath)} ${quote(script)}` };
}

async function poison(repo: string, url: string, scope: "local" | "worktree") {
  if (scope === "worktree") await scalar(repo, "config", "extensions.worktreeConfig", "true");
  const generic = await helper(repo, "repo-helper");
  const scoped = await helper(repo, "url-helper");
  const askpass = await helper(repo, "repo-askpass");
  for (const [key, command] of [
    ["credential.helper", `!${generic.command}`],
    [`credential.${url}.helper`, `!${scoped.command}`],
    ["core.askPass", askpass.command],
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
    const askpass = await helper(repo, "inherited-askpass");
    const service = new GitService({ credentialHelperLookup: async () => [] });
    try {
      await scalar(repo, "remote", "add", "origin", remote.url);
      vi.stubEnv(variable, askpass.command);
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
    processRuntime: {
      spawn: (command, args, input) =>
        spawnGitProcess(command, args, {
          ...input,
          env: { ...input.env, GIT_CONFIG_SYSTEM: system, GIT_CONFIG_GLOBAL: global },
        }),
    },
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
