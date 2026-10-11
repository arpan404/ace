import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setup } from "./publication-project-test-support.ts";

type Fixture = Awaited<ReturnType<typeof setup>>;
export async function configure(f: Fixture) {
  await f.git(f.path, ["config", "user.name", "Test"]);
  await f.git(f.path, ["config", "user.email", "test@example.invalid"]);
  const remote = join(f.root, "remote.git");
  await mkdir(remote);
  await f.git(remote, ["init", "--bare"]);
  await appendFile(
    join(f.root, "gitconfig"),
    `\n[url "file://${remote}"]\n\tinsteadOf = https://github.com/octo/engine.git\n`,
  );
  return remote;
}
export async function commit(f: Fixture, path: string, content: string | Buffer) {
  await mkdir(dirname(join(f.path, path)), { recursive: true });
  await writeFile(join(f.path, path), content);
  await f.git(f.path, ["add", "-f", "--", path]);
  await f.git(f.path, ["commit", "-m", "Fixture"]);
}

