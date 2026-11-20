import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

/*
 * `ace bot publish` loads under Node, as release builds run the CLI (AGENTS.md): Node strips the
 * CLI's TypeScript itself, and a module it can't strip to JavaScript fails the command with
 * "Something went wrong in ace" only once that path is reached. This runs the real path, after
 * the package's check and test and through the market's scanner, until it asks the daemon,
 * which isn't running. A real process because the edge is Node's own loader. Spade's program is
 * a stub printing a passing report: the scenarios themselves are `ace bot test`'s tests.
 */

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

const passing = {
  name: "Fare watcher",
  problems: [],
  scenarios: [
    { file: "tests/hello.json", name: "Says hello", passed: true, failures: [], calls: [] },
  ],
};

test("ace bot publish runs under Node up to the daemon, with nothing Node can't load", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-publish-node-"));
  folders.push(root);
  const bot = join(root, "fare-watcher");
  await mkdir(join(bot, "tests"), { recursive: true });
  await writeFile(
    join(bot, "bot.json"),
    JSON.stringify({
      format: "spade-bot",
      version: 3,
      requires: { runtime: "1" },
      name: "Fare watcher",
      blurb: "Watches fares.",
      task: "You watch fares for the person.",
      model: "fast",
      triggers: [{ kind: "message" }],
      tests: ["tests/hello.json"],
      pricing: { kind: "free" },
    }),
  );
  await writeFile(join(bot, "tests/hello.json"), "{}");
  const spade = join(root, "spade");
  await writeFile(spade, `#!/bin/sh\necho '${JSON.stringify(passing)}'\n`);
  await chmod(spade, 0o755);

  const answer = await new Promise<{ stdout: string; stderr: string }>((done) => {
    execFile(
      "node",
      [cli, "bot", "publish", bot, "--version", "1.0.0", "--json"],
      {
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: root,
          ACE_HOME: join(root, "ace"),
          ACE_SPADE_BIN: spade,
          ACE_THREAD_ID: "",
          ACE_NO_INPUT: "1",
        },
      },
      (_error, stdout, stderr) => done({ stdout, stderr }),
    );
  });
  expect(JSON.parse(answer.stdout), answer.stderr).toMatchObject({
    command: "bot.publish",
    code: "daemon_down",
  });
}, 60_000);
