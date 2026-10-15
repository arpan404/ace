import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SshHostAliases, createCommandRunner, repositoryFromRemote } from "./index.ts";

const signal = () => new AbortController().signal;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A real child process standing in for `ssh -G`, which prints the applied configuration. */
async function fakeSsh(config: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "ace-ssh-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "ssh");
  const calls = join(directory, "calls");
  await writeFile(join(directory, "config.json"), JSON.stringify(config));
  await writeFile(
    script,
    `#!${process.execPath}\nimport {readFileSync,appendFileSync} from 'node:fs';\nconst dir=${JSON.stringify(directory)};\nconst args=process.argv.slice(2);\nappendFileSync(dir+'/calls',args.join(' ')+'\\n');\nconst config=JSON.parse(readFileSync(dir+'/config.json','utf8'));\nif(args[0]!=='-G') process.exit(255);\nconsole.log('user git');\nconsole.log('hostname '+(config[args[1]]??args[1]));\nconsole.log('port 22');\n`,
    { mode: 0o755 },
  );
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  return {
    aliases: (now: () => number) =>
      new SshHostAliases({
        runner: createCommandRunner({ cwd: directory }),
        command: script,
        now,
      }),
    async calls() {
      try {
        return (await readFile(calls, "utf8")).trim().split("\n");
      } catch {
        return [];
      }
    },
  };
}

test("an SSH host alias resolves to github.com", async () => {
  const ssh = await fakeSsh({ "github-work": "github.com" });
  const remote = "git@github-work:octo/ace.git";
  expect(() => repositoryFromRemote(remote)).toThrow();
  const aliases = await ssh.aliases(() => 1_000).resolve([remote], signal());
  expect(aliases).toEqual({ "github-work": "github.com" });
  expect(repositoryFromRemote(remote, {}, aliases)).toEqual({
    forge: "github",
    host: "github.com",
    owner: "octo",
    name: "ace",
  });
});

test("alias lookups are cached and skip hosts that need no resolution", async () => {
  const ssh = await fakeSsh({ "github-work": "github.com" });
  const resolver = ssh.aliases(() => 1_000);
  const remotes = [
    "git@github-work:octo/ace.git",
    "git@github.com:octo/ace.git",
    "https://github.com/octo/ace.git",
  ];
  await resolver.resolve(remotes, signal());
  expect(await resolver.resolve(remotes, signal())).toEqual({ "github-work": "github.com" });
  expect(await ssh.calls()).toEqual(["-G github-work"]);
});

test("GitHub's SSH-over-HTTPS endpoint is github.com", () => {
  expect(repositoryFromRemote("ssh://git@ssh.github.com:443/octo/ace.git")).toMatchObject({
    forge: "github",
    host: "github.com",
    owner: "octo",
    name: "ace",
  });
});
