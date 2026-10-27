import { access, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { GitService } from "./index.ts";
import { execute, put, repository, scalar } from "./test-repo.ts";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * A pull request checkout carrying `scripts/check.sh` and `.husky/pre-commit`, each of which
 * records that it ran. Its path has no spaces, so a hook command can name it as one word.
 */
async function pullRequest() {
  const made = await repository();
  const repo = join(dirname(made), "pull-request");
  await rename(made, repo);
  const marker = join(dirname(repo), "hook-ran");
  const script = `#!/bin/sh\necho ran > '${marker.replaceAll("\\", "/")}'\n`;
  await put(repo, "scripts/check.sh", script);
  await put(repo, ".husky/pre-commit", script);
  const service = new GitService();
  service.protectWorktree(repo);
  const reviewerHooksFor = async (setting: "command" | "hooksPath", value: string) => {
    await scalar(repo, "config", "--unset-all", "hook.lint.command").catch(() => "");
    await scalar(repo, "config", "--unset-all", "core.hooksPath").catch(() => "");
    if (setting === "hooksPath") await scalar(repo, "config", "core.hooksPath", value);
    else {
      await scalar(repo, "config", "hook.lint.event", "pre-commit");
      await scalar(repo, "config", "hook.lint.command", value);
    }
    return service.reviewerHooks(repo);
  };
  return { repo, marker, service, reviewerHooksFor };
}

/** `C:\x\y` as Git for Windows' sh writes it: `/c/x/y`. */
const msys = (path: string) =>
  `/${path.charAt(0).toLowerCase()}${path.slice(2).replaceAll("\\", "/")}`;

describe.runIf(process.platform === "win32")("Windows pull request checkouts", () => {
  test("hooks the checkout carries are skipped however Windows spells their path", async () => {
    const repo = await repository();
    const marker = join(dirname(repo), "hook-ran");
    const service = new GitService();
    service.protectWorktree(repo);
    try {
      await put(repo, "tracked.txt", "edited\n");
      for (const directory of [join(repo, "scripts"), join(repo, ".husky")]) {
        await mkdir(directory, { recursive: true });
        const script = `#!/bin/sh\necho ran > '${marker.replaceAll("\\", "/")}'\n`;
        await writeFile(
          join(directory, directory.endsWith("scripts") ? "check.sh" : "pre-commit"),
          script,
        );
      }
      await scalar(repo, "config", "hook.lint.event", "pre-commit");
      for (const command of ["scripts\\check.sh", ".\\SCRIPTS\\check.sh", "./scripts/check.sh"]) {
        await scalar(repo, "config", "hook.lint.command", command);
        expect(await service.reviewerHooks(repo)).toBe("skipped");
      }
      await scalar(repo, "config", "--unset", "hook.lint.command");
      await scalar(repo, "config", "core.hooksPath", ".HUSKY");
      expect(await service.reviewerHooks(repo)).toBe("skipped");
      const expectedHead = await scalar(repo, "rev-parse", "HEAD");
      await service.asReviewer(() =>
        service.commit({ worktree: repo, expectedHead, message: "Reviewed" }),
      );
      expect(await exists(marker)).toBe(false);
      // The person's own script outside the checkout still runs.
      await scalar(repo, "config", "--unset", "core.hooksPath");
      await scalar(repo, "config", "hook.lint.command", join(dirname(repo), "own.sh"));
      expect(await service.reviewerHooks(repo)).toBe("run");
    } finally {
      await service.close();
    }
  });

  test("a hook command naming the checkout as Git's sh spells it (/c/...) is skipped", async () => {
    const { repo, marker, service, reviewerHooksFor } = await pullRequest();
    try {
      const script = msys(join(repo, "scripts", "check.sh"));
      const upper = `/${script.charAt(1).toUpperCase()}${script.slice(2)}`;
      for (const command of [`"${script}"`, `"/cygdrive${script}"`, `"${upper}" --all`])
        expect(await reviewerHooksFor("command", command)).toBe("skipped");
      await reviewerHooksFor("command", `"${script}"`);
      await put(repo, "tracked.txt", "reviewed\n");
      const reviewedHead = await scalar(repo, "rev-parse", "HEAD");
      await service.asReviewer(() =>
        service.commit({ worktree: repo, expectedHead: reviewedHead, message: "Reviewed" }),
      );
      expect(await exists(marker)).toBe(false);
      // The spelling is live: the person's own commit runs the checkout's script through it.
      await put(repo, "tracked.txt", "the person's\n");
      const ownHead = await scalar(repo, "rev-parse", "HEAD");
      await service.asPerson(() =>
        service.commit({ worktree: repo, expectedHead: ownHead, message: "Own" }),
      );
      expect(await exists(marker)).toBe(true);
    } finally {
      await service.close();
    }
  });

  test("hooks named through the loopback administrative share are skipped", async (context) => {
    const { repo, service, reviewerHooksFor } = await pullRequest();
    try {
      const share = `\\\\localhost\\${repo.charAt(0)}$${repo.slice(2)}`;
      if (!(await exists(share))) context.skip(`${share} isn't reachable on this machine`);
      const forward = share.replaceAll("\\", "/");
      for (const command of [
        `"${forward}/scripts/check.sh"`,
        `'${share}\\scripts\\check.sh'`,
        `'\\\\?\\UNC${share.slice(1)}\\scripts\\check.sh'`,
      ])
        expect(await reviewerHooksFor("command", command)).toBe("skipped");
      expect(await reviewerHooksFor("hooksPath", `${share}\\.husky`)).toBe("skipped");
    } finally {
      await service.close();
    }
  });

  test("hooks named through a device path (\\\\?\\C:\\...) are skipped", async () => {
    const { repo, service, reviewerHooksFor } = await pullRequest();
    try {
      for (const command of [
        `'\\\\?\\${repo}\\scripts\\check.sh'`,
        `'\\\\.\\${repo}\\scripts\\check.sh'`,
      ])
        expect(await reviewerHooksFor("command", command)).toBe("skipped");
      expect(await reviewerHooksFor("hooksPath", `\\\\?\\${repo}\\.husky`)).toBe("skipped");
    } finally {
      await service.close();
    }
  });

  test("hooks named by the checkout's 8.3 short name are skipped", async (context) => {
    const { repo, service, reviewerHooksFor } = await pullRequest();
    try {
      const { stdout } = await execute(
        "cmd.exe",
        ["/d", "/s", "/c", `"for %I in ("${repo}") do @echo %~sI"`],
        { windowsVerbatimArguments: true },
      );
      const short = stdout.trim();
      if (!short || short.toLowerCase() === repo.toLowerCase())
        context.skip("8.3 short names are off on this volume");
      for (const command of [
        `'${short}\\scripts\\check.sh'`,
        `"${short.replaceAll("\\", "/")}/scripts/check.sh"`,
      ])
        expect(await reviewerHooksFor("command", command)).toBe("skipped");
      expect(await reviewerHooksFor("hooksPath", `${short}\\.husky`)).toBe("skipped");
    } finally {
      await service.close();
    }
  });

  test("a junction counts by where it leads, not where it sits", async () => {
    const { repo, service, reviewerHooksFor } = await pullRequest();
    try {
      const own = join(dirname(repo), "own-hooks");
      await mkdir(own);
      await writeFile(join(own, "own.sh"), "#!/bin/sh\nexit 0\n");
      await symlink(own, join(repo, "own-link"), "junction");
      const door = join(dirname(repo), "door");
      await symlink(repo, door, "junction");
      // A junction in the checkout to the person's own folder leads out: their script runs.
      expect(await reviewerHooksFor("command", "own-link/own.sh")).toBe("run");
      expect(await reviewerHooksFor("command", `'${repo}\\own-link\\own.sh'`)).toBe("run");
      // One outside leading into the checkout reaches its author's files.
      expect(await reviewerHooksFor("command", `'${door}\\scripts\\check.sh'`)).toBe("skipped");
      expect(await reviewerHooksFor("hooksPath", `${door}\\.husky`)).toBe("skipped");
    } finally {
      await service.close();
    }
  });

  test("a hook command whose path sh unescapes or expands counts as inside", async () => {
    const { repo, service, reviewerHooksFor } = await pullRequest();
    try {
      const parent = dirname(repo).replaceAll("\\", "/");
      for (const command of [
        `${parent}/pull\\-request/scripts/check.sh`,
        `${parent}/pull-reques?/scripts/check.sh`,
        `\`echo ${parent}\`/pull-request/scripts/check.sh`,
      ])
        expect(await reviewerHooksFor("command", command)).toBe("skipped");
    } finally {
      await service.close();
    }
  });
});
