import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArchive, readRecipe, typeLimits } from "@ace/marketplace";
import type { MarketDraftChecked, MarketMe, Recipe } from "@ace/protocol/marketplace";
import { afterEach, expect, test } from "vitest";
import { checkDraft, confirmedArchive } from "./check.ts";
import type { PickPorts } from "./pick.ts";

/*
 * What a draft would upload, checked on this machine first (ADR 0174 §2): the exact files,
 * what was left home, secrets and hidden text that block, private details the person confirms,
 * a bot's words they edit or confirm, and a source that changed since its check refused.
 */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function folderWith(files: Record<string, string | Uint8Array>) {
  const root = await mkdtemp(join(tmpdir(), "ace-check-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const me: MarketMe = {
  state: "active",
  newPublisher: false,
  limits: {
    uploadsToday: 0,
    uploadsPerDay: 10,
    storedBytes: 0,
    quotaBytes: 1,
    drafts: 0,
    draftLimit: 20,
  },
  profile: {
    id: "pub_1",
    handle: "arloq",
    displayName: "Arlo Quint",
    bio: "",
    links: [],
    joined: 1,
    verified: false,
    proofs: [],
    pins: [],
  },
  entries: [],
  drafts: [],
  transfers: [],
};

const recipe: Recipe = {
  format: "spade-bot",
  version: 2,
  name: "Inbox",
  blurb: "",
  task: "Sort mail for arloq@example.com every morning.",
  model: "fast",
  routines: [
    { name: "Morning sort", instruction: "Sort the inbox.", schedule: "weekdays at 8:00" },
    {
      name: "Backup",
      instruction: "Copy mail to /Users/arloq/Backups.",
      schedule: "daily at 22:00",
    },
  ],
  skills: [],
  plugins: [],
  needs: { connectors: [] },
  notes: [],
};

function ports(over: Partial<PickPorts> = {}): PickPorts {
  const away = () => Promise.reject(new Error("Spade isn't running."));
  return {
    spade: {
      bots: away,
      recipe: async () => ({ recipe, left_out: [] }),
      skills: away,
      skillFiles: away,
    },
    aceSkills: undefined,
    plugins: undefined,
    names: async () => ["Arlo Quint", "arloq"],
    installedFromMarket: () => false,
    ...over,
  };
}

const skill = "---\nname: triage-mail\ndescription: Sorts mail.\n---\nSort it.\n";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const folderDraft = (path: string) =>
  ({
    type: "spade-skill",
    name: "triage-mail",
    source: { kind: "folder", path },
    me: async () => me,
  }) as const;
const sent = (archive: Uint8Array | undefined) =>
  new Map(
    readArchive(archive ?? new Uint8Array(), typeLimits["spade-skill"]).map((f) => [f.path, f]),
  );

test("the check lists exactly what would upload, binaries apart, and what stays home", async () => {
  const root = await folderWith({
    "SKILL.md": skill,
    "scripts/run.sh": "#!/bin/sh\necho ok\n",
    "logo.png": png,
    ".env": "TOKEN=1",
    "deploy.pem": "x",
  });
  const check = await checkDraft(ports(), folderDraft(root));
  expect(check?.files).toEqual([
    { path: "SKILL.md", bytes: skill.length, binary: false },
    { path: "logo.png", bytes: png.length, binary: true },
    { path: "scripts/run.sh", bytes: 18, binary: false },
  ]);
  expect(check?.excluded).toEqual([
    { path: ".env", reason: "hidden" },
    { path: "deploy.pem", reason: "credential" },
  ]);
});

test("secrets and hidden characters block; private details wait for the person", async () => {
  const root = await folderWith({
    "SKILL.md": `${skill}Push with ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789.\n`,
    "notes.md": "Ask Arlo Quint.\nLogs in /Users/arloq/logs.\nSay ‮hello.\n",
  });
  const check = await checkDraft(ports(), folderDraft(root));
  const shown = (check?.findings ?? []).map((f) => [f.path, f.line, f.kind, f.text, f.blocking]);
  expect(shown).toContainEqual(["SKILL.md", 6, "secret", "", true]);
  expect(shown).toContainEqual(["notes.md", 1, "own-name", "Arlo Quint", false]);
  expect(shown).toContainEqual(["notes.md", 2, "home-path", "/Users/arloq/logs", false]);
  expect(
    shown.some(
      ([path, , kind, , blocking]) => path === "notes.md" && kind === "hidden-text" && blocking,
    ),
  ).toBe(true);
  expect(JSON.stringify(check)).not.toContain("ghp_");
});

test("a draft uploads nothing until checked, then only the confirmed files and ticked binaries", async () => {
  const root = await folderWith({
    "SKILL.md": skill,
    "notes.md": "Logs in /Users/arloq/logs.\n",
    "logo.png": png,
  });
  const check = await checkDraft(ports(), folderDraft(root));
  if (!check) throw new Error("no check");
  const confirm = (checked: Partial<MarketDraftChecked>) =>
    confirmedArchive(ports(), {
      ...folderDraft(root),
      checked: { hash: check.hash, binaries: [], accepted: [], ...checked },
    });

  await expect(
    confirmedArchive(ports(), { ...folderDraft(root), checked: undefined }),
  ).rejects.toThrow(/check what will upload/i);
  await expect(confirm({})).rejects.toThrow(/\/Users\/arloq\/logs/);

  const without = sent(await confirm({ accepted: ["/Users/arloq/logs"] }));
  expect([...without.keys()].toSorted()).toEqual(["SKILL.md", "notes.md"]);
  const withLogo = sent(await confirm({ accepted: ["/Users/arloq/logs"], binaries: ["logo.png"] }));
  expect([...withLogo.keys()].toSorted()).toEqual(["SKILL.md", "logo.png", "notes.md"]);
});

test("a source that changed since its check is refused", async () => {
  const root = await folderWith({ "SKILL.md": skill });
  const check = await checkDraft(ports(), folderDraft(root));
  if (!check) throw new Error("no check");
  await writeFile(join(root, "SKILL.md"), `${skill}And mail it to boss@example.com.\n`);
  await expect(
    confirmedArchive(ports(), {
      ...folderDraft(root),
      checked: { hash: check.hash, binaries: [], accepted: ["boss@example.com"] },
    }),
  ).rejects.toThrow(/changed since/);
});

test("a picked plugin must still name itself, and name no other author than you", async () => {
  const plugin = (manifest: object) =>
    folderWith({ ".claude-plugin/plugin.json": JSON.stringify(manifest), "README.md": "Tools.\n" });
  const draft = async (manifest: object) => {
    const folder = await plugin(manifest);
    return checkDraft(
      ports({ plugins: async () => [{ name: "mail-tools", version: "1.0.0", folder }] }),
      {
        type: "spade-plugin",
        name: "mail-tools",
        source: { kind: "plugin", name: "mail-tools" },
        me: async () => me,
      },
    );
  };
  await expect(draft({ name: "mail-tools", author: { name: "Arlo Quint" } })).resolves.toBeTruthy();
  await expect(draft({ name: "mail-tools", author: "arloq" })).resolves.toBeTruthy();
  await expect(draft({ name: "mail-tools", author: { name: "Someone Else" } })).rejects.toThrow(
    /Someone Else/,
  );
  await expect(draft({ name: "calendar", author: "arloq" })).rejects.toThrow(/calendar/);
});

test("anything installed from the marketplace is refused at the check", async () => {
  const folder = await folderWith({ "plugin.json": '{"name":"mail-tools"}' });
  const fromMarket = ports({
    plugins: async () => [{ name: "mail-tools", version: "1.0.0", folder }],
    installedFromMarket: (_type, name) => name === "mail-tools",
  });
  await expect(
    checkDraft(fromMarket, {
      type: "spade-plugin",
      name: "mail-tools",
      source: { kind: "plugin", name: "mail-tools" },
      me: async () => me,
    }),
  ).rejects.toThrow(/isn't yours to publish/);
});

const botDraft = {
  type: "spade-bot",
  name: "inbox",
  source: { kind: "spade-bot", id: "a_1" },
  me: async () => me,
} as const;

test("a bot's check flags its task and each routine, and its routines start left out", async () => {
  const check = await checkDraft(ports(), botDraft);
  expect(check?.bot?.task.map((span) => [span.kind, span.text])).toEqual([
    ["email", "arloq@example.com"],
  ]);
  expect(check?.bot?.routines.map((r) => r.instruction.map((span) => span.text))).toEqual([
    [],
    ["/Users/arloq/Backups"],
  ]);
  expect(check?.files).toEqual([]);
});

test("a bot publishes the task and routines the person confirmed, checked again here", async () => {
  const check = await checkDraft(ports(), botDraft);
  if (!check) throw new Error("no check");
  const confirm = (
    edited: Partial<NonNullable<MarketDraftChecked["recipe"]>>,
    accepted: string[] = [],
  ) =>
    confirmedArchive(ports(), {
      ...botDraft,
      checked: {
        hash: check.hash,
        binaries: [],
        accepted,
        recipe: { task: recipe.task, routines: [], ...edited },
      },
    });

  await expect(
    confirmedArchive(ports(), {
      ...botDraft,
      checked: { hash: check.hash, binaries: [], accepted: [] },
    }),
  ).rejects.toThrow(/confirm the task/i);
  await expect(confirm({})).rejects.toThrow(/arloq@example.com/);
  await expect(
    confirm({ task: "Push with ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789." }, [
      "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
    ]),
  ).rejects.toThrow(/key, token or password/);
  await expect(
    confirm({
      task: "Sort mail every morning.",
      routines: [{ name: "Made up", instruction: "Do it.", schedule: "daily at 9:00" }],
    }),
  ).rejects.toThrow(/Made up/);

  const archive = await confirm({
    task: "Sort mail every morning.",
    routines: [
      { name: "Morning sort", instruction: "Sort the inbox first.", schedule: "weekdays at 8:00" },
    ],
  });
  const files = readArchive(archive ?? new Uint8Array(), typeLimits["spade-bot"]);
  const published = readRecipe(new TextDecoder().decode(files[0]?.content)).recipe;
  expect(published?.task).toBe("Sort mail every morning.");
  expect(published?.routines).toEqual([
    { name: "Morning sort", instruction: "Sort the inbox first.", schedule: "weekdays at 8:00" },
  ]);
});
