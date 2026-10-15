import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { createCommandRunner } from "@ace/forge";
import { spawnGitProcess } from "@ace/git";
import { Command, Thread } from "@ace/protocol";
import { SettingsService } from "@ace/settings";
import { SourceControl } from "./source-control.ts";
import { Store } from "./store.ts";
import { migrateEngine } from "./engine/migrations.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const git = promisify(execFile);
const alias = "git@github-work:octo/ace.git";

/**
 * OpenSSH resolves `~` from the passwd entry, not `$HOME`, so a HOME override cannot steer the
 * real client. This stand-in applies `$HOME/.ssh/config` the way `ssh -G` does for Host/HostName.
 */
const ssh = `#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';
const home=process.env.HOME, args=process.argv.slice(2);
appendFileSync(home+'/ssh-calls',args.join(' ')+'\\n');
if(args[0]!=='-G') process.exit(255);
let text=''; try { text=readFileSync(home+'/.ssh/config','utf8'); } catch {}
let current=false, hostname=args[1];
for (const line of text.split('\\n')) {
  const [key,value]=line.trim().split(/\\s+/);
  if(key?.toLowerCase()==='host') current=value===args[1];
  else if(current && key?.toLowerCase()==='hostname') hostname=value;
}
console.log('user git'); console.log('hostname '+hostname.toLowerCase()); console.log('port 22');
`;

async function fixture(sshConfig: string) {
  const root = await mkdtemp(join(tmpdir(), "ace-ssh-wiring-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const bare = join(root, "hosted.git");
  await mkdir(join(home, ".ssh"), { recursive: true });
  await mkdir(bin);
  await writeFile(join(home, ".ssh", "config"), sshConfig);
  await writeFile(join(bin, "ssh"), ssh, { mode: 0o755 });
  await writeFile(join(bin, "package.json"), '{"type":"module"}');
  await git("git", ["init", "-q", "-b", "main", repo]);
  await git("git", ["init", "--bare", "-q", bare]);
  await git("git", ["-C", repo, "remote", "add", "origin", alias]);
  await git("git", ["-C", repo, "config", "user.name", "Test"]);
  await git("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  await writeFile(join(repo, "tracked"), "head");
  await git("git", ["-C", repo, "add", "tracked"]);
  await git("git", ["-C", repo, "commit", "-qm", "Initial"]);
  await git("git", ["-C", repo, "switch", "-qc", "topic"]);
  // The hosted repository behind the alias is a local bare repository for the push.
  const pushConfig = join(root, "push.gitconfig");
  await git("git", [
    "config",
    "--file",
    pushConfig,
    `url.${pathToFileURL(bare).href}.insteadOf`,
    alias,
  ]);
  const settings = new SettingsService({ dataDir: root });
  await settings.set(
    "sourceControl.preferences",
    { hosts: [{ host: "github.com" }], host: "github.com", remote: "origin" },
    { kind: "global" },
  );
  const sourceControl = new SourceControl(
    settings,
    (cwd) =>
      createCommandRunner({
        cwd,
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home },
      }),
    root,
  );
  const store = new Store(join(root, "events.sqlite"));
  // The engine owns session rows; a runtime without it still needs the schema.
  store.atomic((db) => migrateEngine(db));
  const workspaceId = store.createWorkspace(repo, "Project");
  const thread = Thread.parse({
    id: "alias-thread",
    workspaceId,
    provider: "codex",
    title: "Alias",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, root, () => 1000, {
    sourceControl,
    git: {
      transportProtocols: ["file"],
      processRuntime: {
        spawn(command, args, options) {
          return spawnGitProcess(command, args, {
            ...options,
            env: {
              ...options.env,
              ...(args.includes("push")
                ? { GIT_CONFIG_GLOBAL: pushConfig, GIT_CONFIG_NOSYSTEM: "1" }
                : {}),
            },
          });
        },
      },
    },
  });
  return {
    thread,
    runtime,
    bare,
    sshCalls: async () => (await readFile(join(home, "ssh-calls"), "utf8")).trim().split("\n"),
    async close() {
      await runtime.close();
      sourceControl.close();
      await settings.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("an SSH host alias in ~/.ssh/config reaches repository detection and push", async () => {
  const f = await fixture("Host github-work\n  HostName github.com\n  User git\n");
  try {
    const details = await f.runtime.details(f.thread.id);
    expect(details.repository).toEqual({
      forge: "github",
      host: "github.com",
      owner: "octo",
      name: "ace",
    });
    if (!details.head || !details.branch) throw new Error("Expected a committed branch");
    expect(
      await f.runtime.execute(
        Command.parse({
          id: "push-alias",
          deviceId: "device",
          payload: {
            type: "git.push",
            threadId: f.thread.id,
            remote: "origin",
            target: { repository: details.repository, branch: details.branch, head: details.head },
          },
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      (await git("git", ["--git-dir", f.bare, "rev-parse", "refs/heads/topic"])).stdout.trim(),
    ).toBe(details.head);
    // Resolved once and reused, not once per read.
    expect(await f.sshCalls()).toEqual(["-G github-work"]);
  } finally {
    await f.close();
  }
});

test("an alias the SSH configuration doesn't map stays an unsupported remote", async () => {
  const f = await fixture("Host other\n  HostName github.com\n");
  try {
    expect((await f.runtime.details(f.thread.id)).repository).toBeUndefined();
  } finally {
    await f.close();
  }
});
