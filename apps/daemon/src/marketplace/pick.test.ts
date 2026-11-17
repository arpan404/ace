import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArchive, readRecipe, typeLimits, type ArchiveFile } from "@ace/marketplace";
import { afterEach, expect, test } from "vitest";
import { draftArchive } from "./draft-files.ts";
import { entryNameOf, listPublishables, pickedSource, type PickPorts } from "./pick.ts";
import { Refused } from "./prepare.ts";

/* The publish flow's picker: what the person can publish, and the files of what they picked. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function skillFolder() {
  const root = await mkdtemp(join(tmpdir(), "ace-pick-"));
  roots.push(root);
  const folder = join(root, "triage-mail");
  await mkdir(join(folder, "scripts"), { recursive: true });
  await mkdir(join(folder, ".git"));
  await writeFile(
    join(folder, "SKILL.md"),
    "---\nname: triage-mail\ndescription: Sorts mail.\n---\nSort it.\n",
  );
  await writeFile(join(folder, "scripts/sort.sh"), "#!/bin/sh\necho sorted\n");
  await chmod(join(folder, "scripts/sort.sh"), 0o755);
  await writeFile(join(folder, ".git/HEAD"), "ref: refs/heads/main\n");
  return folder;
}

const away = () => Promise.reject(new Error("Spade isn't running."));

function ports(
  over: {
    spade?: Partial<PickPorts["spade"]>;
    aceSkills?: PickPorts["aceSkills"];
    plugins?: PickPorts["plugins"];
  } = {},
): PickPorts {
  return {
    spade: {
      bots: away,
      recipe: away,
      skills: away,
      skillFiles: away,
      ...over.spade,
    },
    aceSkills: over.aceSkills,
    plugins: over.plugins,
  };
}

const files = (archive: Uint8Array) =>
  new Map(
    readArchive(archive, typeLimits["spade-skill"]).map((file) => [file.path, file] as const),
  );

test("a picked ace skill is read from its own folder: its files, their run bits, never .git", async () => {
  const folder = await skillFolder();
  const id = `skl_${"a".repeat(40)}`;
  const pick = ports({
    aceSkills: async () => [
      { id, name: "triage-mail", title: undefined, description: "Sorts mail.", folder },
    ],
  });
  const source = await pickedSource(pick, { kind: "ace-skill", id });
  expect(source).toEqual({ kind: "folder", path: folder });
  if (!source) throw new Error("no source");
  const read = files(await draftArchive(source));
  expect([...read.keys()].toSorted()).toEqual(["SKILL.md", "scripts/sort.sh"]);
  expect(read.get("scripts/sort.sh")?.executable).toBe(true);
  expect(new TextDecoder().decode(read.get("SKILL.md")?.content)).toContain("Sort it.");
});

test("a skill that isn't one of the person's own is refused, and a linked file stops the draft", async () => {
  const folder = await skillFolder();
  const id = `skl_${"b".repeat(40)}`;
  const pick = ports({ aceSkills: async () => [] });
  await expect(pickedSource(pick, { kind: "ace-skill", id })).rejects.toMatchObject({
    code: "not_found",
  });

  await symlink("/etc/hosts", join(folder, "hosts"));
  const linked = ports({
    aceSkills: async () => [{ id, name: "triage-mail", title: undefined, description: "", folder }],
  });
  const source = await pickedSource(linked, { kind: "ace-skill", id });
  if (!source) throw new Error("no source");
  await expect(draftArchive(source)).rejects.toThrow(Refused);
  await expect(draftArchive(source)).rejects.toThrow(/hosts is a link/);
});

test("a picked Spade skill's files become the draft's archive as Spade gave them", async () => {
  const given: ArchiveFile[] = [
    { path: "SKILL.md", executable: false, content: new TextEncoder().encode("# Notes\n") },
    { path: "tool.sh", executable: true, content: new TextEncoder().encode("#!/bin/sh\n") },
  ];
  const pick = ports({ spade: { skillFiles: async () => given } });
  const source = await pickedSource(pick, { kind: "spade-skill", id: "sks_01" });
  if (!source) throw new Error("no source");
  const read = files(await draftArchive(source));
  expect(read.get("tool.sh")?.executable).toBe(true);
  expect(new TextDecoder().decode(read.get("SKILL.md")?.content)).toBe("# Notes\n");
});

test("a picked bot is its recipe as bot.json, with nothing Spade sent beyond the recipe", async () => {
  const pick = ports({
    spade: {
      recipe: async () => ({
        recipe: {
          format: "spade-bot",
          version: 2,
          name: "Inbox",
          task: "You look after the inbox.",
          model: "fast",
          routines: [{ name: "Morning", instruction: "Sort it.", schedule: "weekdays at 8:00" }],
          needs: { connectors: [{ id: "gmail", why: "Reads mail.", required: true }] },
          grants: { connectors: ["con_1"] },
        },
        left_out: ["Its heartbeat isn't part of a recipe."],
        token: "never",
      }),
    },
  });
  const source = await pickedSource(pick, { kind: "spade-bot", id: "a_inbox" });
  if (!source) throw new Error("no source");
  const read = files(await draftArchive(source));
  expect([...read.keys()]).toEqual(["bot.json"]);
  const text = new TextDecoder().decode(read.get("bot.json")?.content);
  expect(text).not.toContain("grants");
  expect(text).not.toContain("never");
  const recipe = readRecipe(text);
  expect(recipe.problems).toEqual([]);
  expect(recipe.recipe?.routines[0]?.schedule).toBe("weekdays at 8:00");
});

test("skills list from Spade and ace's library, and a place that's away says so", async () => {
  const listed = await listPublishables(
    ports({
      aceSkills: async () => [
        {
          id: `skl_${"c".repeat(40)}`,
          name: "triage-mail",
          title: "Triage mail",
          description: "Sorts mail.\nMore.",
          folder: "/x",
        },
      ],
    }),
    "spade-skill",
  );
  expect(listed.items.map((item) => [item.title, item.line, item.from, item.source.kind])).toEqual([
    ["Triage mail", "Sorts mail.", "ace", "ace-skill"],
  ]);
  expect(listed.unavailable).toEqual(["Spade's skills can't be listed: Spade isn't running."]);
});

test("a thing's own name becomes its marketplace name", () => {
  expect(entryNameOf("Inbox Sorter", "my-bot")).toBe("inbox-sorter");
  expect(entryNameOf("  Café — notes!! ", "my-skill")).toBe("cafe-notes");
  expect(entryNameOf("✨", "my-bot")).toBe("my-bot");
});
