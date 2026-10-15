import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AdapterRegistry, startDaemon } from "@ace/daemon";
import { createTurnProvider, ScriptedTurnConfig } from "@ace/adapter-testkit";
import { ManualClock } from "./engine/test-support.ts";
import { git } from "./test-git.ts";

async function launch(home: string) {
  const clock = new ManualClock();
  const registry = new AdapterRegistry();
  registry.register(
    createTurnProvider({
      provider: "codex",
      reply: "Ordinary thread continued",
      config: ScriptedTurnConfig.parse({}),
      now: clock.now,
      schedule: () => () => {},
    }),
    { installed: true, auth: "logged_in", loginHint: "scripted" },
  );
  const daemon = await startDaemon({
    config: {
      dataDir: home,
      cursorSdkHome: join(home, "cursor"),
      host: "127.0.0.1",
      port: 0,
      listen: "local",
      remotePort: 0,
      logLevel: "warn",
    },
    engine: { registry, clock, cursor: { env: { ...process.env, HOME: home, PATH: "" } } },
    accounts: { env: { ...process.env, HOME: home, PATH: "" } },
    providerStatus: { env: { ...process.env, HOME: home, PATH: "" } },
  });
  await daemon.engine?.flush();
  return daemon;
}

async function logs(home: string) {
  const directory = join(home, "logs");
  return (
    await Promise.all(
      (await readdir(directory)).map((file) => readFile(join(directory, file), "utf8")),
    )
  ).join("\n");
}

test("first upgrade removes only clean Deck worktrees and logs retained uncommitted work without following symlinks", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-retired-worktrees-"));
  let daemon: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const repo = join(home, "repo");
    await mkdir(repo);
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.name", "Fixture");
    git(repo, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(repo, "tracked.txt"), "original");
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    git(repo, "add", "tracked.txt", ".gitignore");
    git(repo, "commit", "-m", "Initial");
    const directory = join(home, "deck-worktrees");
    const cases = ["clean", "tracked", "staged", "untracked", "hidden", "ignored", "locked"];
    for (const name of cases) git(repo, "worktree", "add", "-b", name, join(directory, name));
    await writeFile(join(directory, "tracked", "tracked.txt"), "uncommitted tracked");
    await writeFile(join(directory, "staged", "tracked.txt"), "uncommitted staged");
    git(join(directory, "staged"), "add", "tracked.txt");
    await writeFile(join(directory, "untracked", "new.txt"), "uncommitted new file");
    git(join(directory, "hidden"), "update-index", "--assume-unchanged", "tracked.txt");
    await writeFile(join(directory, "hidden", "tracked.txt"), "hidden uncommitted work");
    await writeFile(join(directory, "ignored", "ignored.txt"), "ignored uncommitted work");
    git(repo, "worktree", "lock", join(directory, "locked"));
    await symlink(repo, join(directory, "alias"), "dir");
    daemon = await launch(home);
    expect((await readdir(directory)).toSorted()).toEqual([
      "alias",
      "hidden",
      "ignored",
      "locked",
      "staged",
      "tracked",
      "untracked",
    ]);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(join(directory, "clean"));
    for (const name of ["hidden", "ignored", "locked", "staged", "tracked", "untracked", "alias"])
      expect(await logs(home)).toContain(`/deck-worktrees/${name}`);
    expect(await readFile(join(directory, "hidden", "tracked.txt"), "utf8")).toBe(
      "hidden uncommitted work",
    );
    expect(await readFile(join(directory, "untracked", "new.txt"), "utf8")).toBe(
      "uncommitted new file",
    );
    expect(await readFile(join(directory, "ignored", "ignored.txt"), "utf8")).toBe(
      "ignored uncommitted work",
    );
    await daemon.close();
    daemon = undefined;
    // A later clean tree belongs to the user now; cleanup is an upgrade pass, not ongoing deletion.
    git(join(directory, "tracked"), "restore", "tracked.txt");
    daemon = await launch(home);
    expect(await readFile(join(directory, "tracked", "tracked.txt"), "utf8")).toBe("original");
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("original");
  } finally {
    await daemon?.close();
    await rm(home, { recursive: true, force: true });
  }
});
