import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invoke } from "../cli-test-support.ts";

/*
 * `ace bot init|check|test` as a developer runs them (ADR 0200 §9): the real CLI in its own
 * process, and Spade's own program running the scenarios. `spade` is the checkout's debug build;
 * CI builds it before the tests.
 */

const spade = fileURLToPath(new URL("../../../../spade/target/debug/spade", import.meta.url));
const haveSpade = existsSync(spade) || process.env.CI === "true";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-bot-kit-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** `ace …` with a home of its own: nothing of the person's, Spade's program named. */
const ace = (...args: string[]) =>
  invoke(join(root, "ace"), args, "", {
    HOME: root,
    ACE_SPADE_BIN: spade,
    ACE_THREAD_ID: "",
    ACE_NO_INPUT: "",
  });

const json = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>;

async function writePackage(folder: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(folder, path, ".."), { recursive: true });
    await writeFile(join(folder, path), text);
  }
}

const bot = (fields: Record<string, unknown>) =>
  JSON.stringify({
    format: "spade-bot",
    version: 3,
    requires: { runtime: "1" },
    name: "Fare watcher",
    blurb: "Watches fares.",
    task: "You watch fares for the person.",
    model: "fast",
    triggers: [{ kind: "message" }],
    pricing: { kind: "free" },
    ...fields,
  });

describe.skipIf(!haveSpade)("a package ace bot init makes", () => {
  it.each(["blank", "watcher", "club-member"])(
    "from %s passes ace bot check and its own ace bot test",
    async (template) => {
      const folder = join(root, `made-${template}`);
      const made = await ace(
        "bot",
        "init",
        "Fare watcher",
        "--template",
        template,
        "--path",
        folder,
        "--json",
      );
      expect(made.code, made.stderr).toBe(0);
      const files = json(made.stdout)["files"];
      expect(files).toEqual(
        expect.arrayContaining(["bot.json", "README.md", "tests/first-message.json"]),
      );
      expect(files).toEqual(
        expect.arrayContaining([expect.stringMatching(/^skills\/.+\/SKILL\.md$/)]),
      );
      expect(files).toEqual(expect.arrayContaining([expect.stringMatching(/^cards\/.+\.json$/)]));
      // The watcher ships a panel: its one page, declared in bot.json (ADR 0200 §5.2).
      if (template === "watcher")
        expect(files).toEqual(expect.arrayContaining(["panels/watching/index.html"]));

      const checked = await ace("bot", "check", folder, "--json");
      expect(checked.code, checked.stderr).toBe(0);
      expect(json(checked.stdout)).toMatchObject({ warnings: [] });

      const tested = await ace("bot", "test", folder, "--json");
      expect(tested.code, tested.stdout + tested.stderr).toBe(0);
      const report = json(tested.stdout);
      expect(report["passed"]).toBe(true);
      expect((report["scenarios"] as unknown[]).length).toBeGreaterThan(0);
    },
  );

  it("refuses a folder that already holds files", async () => {
    const folder = join(root, "made-blank");
    const again = await ace("bot", "init", "Fare watcher", "--path", folder, "--json");
    expect(again.code).toBe(4);
    expect(json(again.stdout)).toMatchObject({ code: "conflict" });
  });
});

describe("ace bot check", () => {
  it("names every problem of a bad package at its place, and exits 1", async () => {
    const folder = join(root, "bad");
    await writePackage(folder, {
      "bot.json": bot({
        publisher: "acme",
        effects: [{ effect: "network" }, { effect: "credential", why: "Reads your keys." }],
        tests: ["tests/missing.json"],
      }),
      "run.sh": "#!/bin/sh\necho hi\n",
    });
    await chmod(join(folder, "run.sh"), 0o755);
    const checked = await ace("bot", "check", folder, "--json");
    expect(checked.code).toBe(1);
    const error = json(checked.stdout);
    expect(error).toMatchObject({ ok: false, code: "check_failed" });
    const problems = (error["problems"] as { path?: string; message: string }[]).map(
      (problem) => `${problem.path}: ${problem.message}`,
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^bot\.json: publisher: .*signed manifest/),
        "bot.json: effects[0].why says in a sentence why it needs this",
        expect.stringMatching(/^bot\.json: effects\[1\]: credential can't be declared/),
        expect.stringMatching(/^run\.sh: run\.sh is executable outside skills\//),
        "tests/missing.json: tests/missing.json is named in tests but isn't in the package",
      ]),
    );

    // Each said once, in sentences: no schema error printed raw beside them.
    expect(problems).toHaveLength(5);

    // In words, each problem on its own line under the sentence.
    const human = await ace("bot", "check", folder);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain("bot.json: effects[0].why says in a sentence why it needs this");
  });

  it("passes a package whose effect has a thin why, and warns about it", async () => {
    const folder = join(root, "thin");
    await writePackage(folder, {
      "bot.json": bot({ effects: [{ effect: "network", why: "Fares." }] }),
    });
    const checked = await ace("bot", "check", folder, "--json");
    expect(checked.code, checked.stdout).toBe(0);
    const warnings = (json(checked.stdout)["warnings"] as { message: string }[]).map(
      (w) => w.message,
    );
    expect(warnings).toEqual([
      expect.stringMatching(/^effects\[0\]\.why is short/),
      expect.stringMatching(/^tests names no scenario/),
    ]);
  });
});

describe.skipIf(!haveSpade)("ace bot test", () => {
  it("fails a failing scenario, and its fake tool never reaches the network", async () => {
    // A server the scenario's fetch names: a real request would land here.
    let reached = 0;
    const server = createServer((_request, response) => {
      reached += 1;
      response.end("a real page");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const folder = join(root, "failing");
      await writePackage(folder, {
        "bot.json": bot({
          effects: [{ effect: "network", why: "Reads fares from the fare site." }],
          tests: ["tests/watch.json"],
        }),
        "tests/watch.json": JSON.stringify({
          name: "Says the fare",
          given: { message: "What does KTM to DEL cost?" },
          model: [
            { calls: [{ tool: "web_fetch", arguments: { url: `http://127.0.0.1:${port}/fare` } }] },
            { calls: [{ tool: "send_message", arguments: { to: "a@example.com", text: "hi" } }] },
            { say: "I couldn't find a fare." },
          ],
          tools: { web_fetch: "KTM-DEL 182 USD" },
          expect: { calls: ["web_fetch"], reply_contains: ["182"] },
        }),
      });
      const tested = await ace("bot", "test", folder, "--json");
      expect(tested.code, tested.stderr).toBe(1);
      const error = json(tested.stdout);
      expect(error).toMatchObject({ ok: false, code: "check_failed" });
      const problems = (error["problems"] as { path?: string; message: string }[]).map(
        (problem) => `${problem.path}: ${problem.message}`,
      );
      expect(problems).toEqual([
        expect.stringMatching(
          /^tests\/watch\.json: Says the fare: send_message was refused: Fare watcher doesn't declare sending in your name\./,
        ),
        'tests/watch.json: Says the fare: The reply doesn\'t say "182"',
      ]);
      expect(reached, "the fetch was the scenario's fake, not the network").toBe(0);
    } finally {
      server.close();
    }
  });

  it("reports a scenario that doesn't read, at its place", async () => {
    const folder = join(root, "unreadable");
    await writePackage(folder, {
      "bot.json": bot({ tests: ["tests/typo.json"] }),
      "tests/typo.json": JSON.stringify({
        name: "Typo",
        given: { message: "Hi" },
        model: [{ say: "Hi" }],
        expects: {},
      }),
    });
    const tested = await ace("bot", "test", folder);
    expect(tested.code).toBe(1);
    expect(tested.stderr).toMatch(/tests\/typo\.json: unknown field `expects`/);
  });
});
