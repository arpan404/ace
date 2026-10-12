import { access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService, spawnGitProcess } from "./index.ts";
import { repository, scalar } from "./test-repo.ts";
import { supportsNamedHooks } from "./hook-test-fixtures.ts";
import { quote } from "./credential-test-fixtures.ts";

test("a reserved-name shadow refuses a push when a fresh hook is inserted after discovery", async (context) => {
  const repo = await repository();
  if (!(await supportsNamedHooks(repo)))
    context.skip("Installed Git does not support configured hooks");
  const remote = join(dirname(repo), "remote.git");
  await scalar(repo, "init", "--bare", remote);
  await scalar(repo, "remote", "add", "origin", `file://${remote}`);
  await scalar(repo, "config", "hook.reference-transaction.command", ":");
  const marker = join(dirname(repo), "raced-hook-executed");
  let inserted = false;
  const service = new GitService({
    transportProtocols: ["file"],
    credentialHelperLookup: async () => [],
    processRuntime: {
      spawn: (command, args, options) => {
        const child = spawnGitProcess(command, args, options);
        if (!inserted && args.includes("--show-scope"))
          child.once("close", () => {
            inserted = true;
            execFileSync(
              "git",
              ["config", "hook.fresh.command", `printf executed > ${quote(marker)}`],
              { cwd: repo },
            );
            execFileSync("git", ["config", "hook.fresh.event", "reference-transaction"], {
              cwd: repo,
            });
          });
        return child;
      },
    },
  });
  service.protectWorktree(repo);
  try {
    await expect(service.push({ worktree: repo, remote: "origin" })).rejects.toMatchObject({
      code: "unsupported_repository",
    });
    // Verify the external mutation happened: absence of the marker alone cannot prove safety.
    expect(await scalar(repo, "config", "--get", "hook.fresh.event")).toBe("reference-transaction");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(scalar(remote, "rev-parse", "--verify", "HEAD")).rejects.toBeDefined();
  } finally {
    await service.close();
  }
});

test.each(["enabled", "jobs", "parallel"])(
  "protected operations reject reserved hook event names even when only %s is configured",
  async (field) => {
    const repo = await repository();
    await scalar(
      repo,
      "config",
      `hook.reference-transaction.${field}`,
      field === "jobs" ? "1" : "true",
    );
    const service = new GitService();
    service.protectWorktree(repo);
    try {
      await expect(service.status(repo)).rejects.toMatchObject({ code: "unsupported_repository" });
    } finally {
      await service.close();
    }
  },
);
