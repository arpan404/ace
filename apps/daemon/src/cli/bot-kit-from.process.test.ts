import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { invoke } from "../cli-test-support.ts";
import {
  canRunSpade,
  spadeProgram,
  startThrowawaySpade,
  type SpadeApi,
  type ThrowawaySpade,
} from "./bot-kit-test-support.ts";

/*
 * `ace bot init --from BOT` on a development Spade (ADR 0200 §9): one of the person's bots becomes
 * a package folder with its task, personality and routines as triggers, that passes `ace bot
 * check` (warning on each TODO left to write) and `ace bot test` as written. The bot's
 * conversation, notes and webhook secret never reach the folder; a bot from someone else's
 * package is refused. Which effects a draft declares from the bot's calls is Spade's, tested in
 * `spade/crates/spade-server/tests/package_draft.rs`.
 */

const run = canRunSpade;

let root: string;
let spade: ThrowawaySpade | undefined;
let api: SpadeApi;

beforeAll(async () => {
  if (!run) return;
  root = await mkdtemp(join(tmpdir(), "ace-bot-from-"));
  spade = await startThrowawaySpade(root);
  ({ api } = spade);
}, 30_000);

afterAll(async () => {
  spade?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

const env = () => ({
  HOME: join(root, "home"),
  ACE_THREAD_ID: "",
  ACE_NO_INPUT: "",
  ACE_SPADE_BIN: spadeProgram,
});
const ace = (...args: string[]) => invoke(join(root, "ace"), args, "", env());

const made = async (method: string, path: string, body: unknown) => {
  const answer = await api(method, path, body);
  expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(300);
  return answer.body as Record<string, Record<string, unknown>>;
};

/** Every file's text under `folder`. */
async function texts(folder: string): Promise<string> {
  const names = await readdir(folder, { recursive: true, withFileTypes: true });
  const files = names.filter((entry) => entry.isFile());
  const read = await Promise.all(
    files.map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
  );
  return read.join("\n");
}

it.skipIf(!run)(
  "makes a package of the person's bot that checks and tests as written, leaving the person's things home",
  async () => {
    const bot = String(
      (
        await made("POST", "/v1/agents", {
          name: "Release notes",
          task: "You write release notes from the week's merged changes.",
          model: "unreached/m",
        })
      ).agent?.["id"],
    );
    const agent = (await made("GET", "/v1/agents", undefined)) as unknown as {
      agents: { id: string; conversation: string }[];
    };
    const conversation = agent.agents.find((one) => one.id === bot)?.conversation ?? "";
    await made("PATCH", `/v1/agents/${bot}`, {
      personality: { tone: "warm", humour: false, emoji: false },
    });
    await made("POST", `/v1/agents/${bot}/routines`, {
      name: "Friday notes",
      instruction: "Write the week's notes.",
      trigger: { kind: "schedule", schedule: "0 16 * * 5" },
    });
    const hook = await made("POST", `/v1/agents/${bot}/routines`, {
      name: "On a push",
      instruction: "Read the push.",
      trigger: { kind: "webhook" },
    });
    const secret = String((hook.routine?.["webhook"] as { secret?: string })?.secret ?? "");
    await made("POST", `/v1/agents/${bot}/notes`, { text: "Their manager is called Priya." });
    // The model never answers; the person's words are still in the conversation.
    await made("POST", `/v1/conversations/${conversation}/messages`, {
      text: "My sister Asha's birthday is on the ninth.",
    });

    const folder = join(root, "release-notes");
    const init = await ace(
      "bot",
      "init",
      "--from",
      "release notes",
      "--spade",
      spade?.data ?? "",
      "--path",
      folder,
      "--json",
    );
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(JSON.parse(init.stdout)).toMatchObject({
      path: folder,
      name: "Release notes",
      from: bot,
      files: ["bot.json", "README.md", "tests/first-message.json"],
    });
    const manifest = JSON.parse(await readFile(join(folder, "bot.json"), "utf8"));
    expect(manifest).toMatchObject({
      format: "spade-bot",
      version: 3,
      name: "Release notes",
      task: "You write release notes from the week's merged changes.",
      personality: { tone: "warm", humour: false, emoji: false },
      model: "fast",
      triggers: [
        { kind: "message" },
        {
          kind: "schedule",
          name: "Friday notes",
          instruction: "Write the week's notes.",
          schedule: "0 16 * * 5",
        },
        { kind: "webhook", name: "On a push", instruction: "Read the push." },
      ],
      tests: ["tests/first-message.json"],
      pricing: { kind: "free" },
    });

    const all = await texts(folder);
    for (const absent of ["Asha", "Priya", "unreached", conversation, secret]) {
      expect(absent, "a value to look for").not.toBe("");
      expect(all.includes(absent), `the folder holds ${absent}`).toBe(false);
    }

    const check = await ace("bot", "check", folder, "--json");
    expect(check.code, check.stdout).toBe(0);
    const warnings = JSON.parse(check.stdout).warnings.map((w: { message: string }) => w.message);
    expect(warnings).toContainEqual(expect.stringMatching(/^blurb still says TODO/));

    const test = await ace("bot", "test", folder, "--json");
    expect(test.code, test.stdout + test.stderr).toBe(0);
    expect(JSON.parse(test.stdout)).toMatchObject({ scenarios: [{ passed: true }] });

    // The folder is the developer's now: a second init there is refused, nothing overwritten.
    const again = await ace(
      "bot",
      "init",
      "--from",
      bot,
      "--spade",
      spade?.data ?? "",
      "--path",
      folder,
    );
    expect(again.code).toBe(4);
    expect(JSON.parse(await readFile(join(folder, "bot.json"), "utf8"))).toEqual(manifest);
  },
  60_000,
);

it.skipIf(!run)(
  "refuses a bot from someone else's package, and names no bot that isn't there",
  async () => {
    await made("POST", "/v1/agents", {
      recipe: {
        format: "spade-bot",
        version: 2,
        name: "Inbox",
        blurb: "",
        task: "You sort mail.",
        model: "fast",
      },
      from_recipe: { source: "market", name: "inbox", version: "1.0.0" },
      grants: { connectors: [], plugins: [], skills: [] },
      start_routines: false,
    });
    const data = spade?.data ?? "";
    const theirs = await ace(
      "bot",
      "init",
      "--from",
      "Inbox",
      "--spade",
      data,
      "--path",
      join(root, "inbox"),
      "--json",
    );
    expect(theirs.code, theirs.stdout).toBe(1);
    expect(JSON.parse(theirs.stdout).error).toMatch(/maker's package/);
    await expect(readdir(join(root, "inbox"))).rejects.toThrow();

    const nobody = await ace("bot", "init", "--from", "Nobody", "--spade", data, "--json");
    expect(nobody.code, nobody.stdout).not.toBe(0);
    expect(JSON.parse(nobody.stdout)).toMatchObject({ code: "not_found" });
  },
  30_000,
);
