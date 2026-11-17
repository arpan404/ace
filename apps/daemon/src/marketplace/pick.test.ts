import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchiveFile } from "@ace/marketplace";
import { afterEach, expect, test } from "vitest";
import { entryNameOf, listPublishables, readPicked, type PickPorts } from "./pick.ts";

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
const text = (path: string, executable = false): ArchiveFile => ({
  path,
  executable,
  content: new TextEncoder().encode("x"),
});
const market = (type: string, name: string) =>
  (type === "spade-skill" && name === "triage-mail") ||
  (type === "spade-plugin" && name === "calendar");

function ports(
  over: {
    spade?: Partial<PickPorts["spade"]>;
    aceSkills?: PickPorts["aceSkills"];
    plugins?: PickPorts["plugins"];
    installedFromMarket?: PickPorts["installedFromMarket"];
  } = {},
): PickPorts {
  return {
    spade: { bots: away, recipe: away, skills: away, skillFiles: away, ...over.spade },
    aceSkills: over.aceSkills,
    plugins: over.plugins,
    names: async () => [],
    installedFromMarket: over.installedFromMarket ?? (() => false),
  };
}

test("a picked ace skill is read from its own folder: its files, their run bits, never .git", async () => {
  const folder = await skillFolder();
  const id = `skl_${"a".repeat(40)}`;
  const pick = ports({
    aceSkills: async () => [
      { id, name: "triage-mail", title: undefined, description: "Sorts mail.", folder },
    ],
  });
  const read = await readPicked(pick, "spade-skill", { kind: "ace-skill", id });
  if (read?.kind !== "files") throw new Error("no files");
  expect(read.files.map((file) => file.path).toSorted()).toEqual(["SKILL.md", "scripts/sort.sh"]);
  expect(read.files.find((file) => file.path === "scripts/sort.sh")?.executable).toBe(true);
  expect(read.picked).toBe("triage-mail");
});

test("a skill that isn't one of the person's own is refused, and a linked file stops the read", async () => {
  const folder = await skillFolder();
  const id = `skl_${"b".repeat(40)}`;
  await expect(
    readPicked(ports({ aceSkills: async () => [] }), "spade-skill", { kind: "ace-skill", id }),
  ).rejects.toMatchObject({ code: "not_found" });

  await symlink("/etc/hosts", join(folder, "hosts"));
  const linked = ports({
    aceSkills: async () => [{ id, name: "triage-mail", title: undefined, description: "", folder }],
  });
  await expect(readPicked(linked, "spade-skill", { kind: "ace-skill", id })).rejects.toThrow(
    /hosts is a link/,
  );
});

test("a Spade skill's files keep the folder rules: hidden and credential files stay home", async () => {
  const pick = ports({
    spade: {
      skills: async () => [{ id: "sks_01", name: "notes", description: "" }],
      skillFiles: async () => [
        text("SKILL.md"),
        text("tool.sh", true),
        text(".env"),
        text("keys/id_rsa"),
      ],
    },
  });
  const read = await readPicked(pick, "spade-skill", { kind: "spade-skill", id: "sks_01" });
  if (read?.kind !== "files") throw new Error("no files");
  expect(read.files.map((file) => file.path)).toEqual(["SKILL.md", "tool.sh"]);
  expect(read.excluded).toEqual([
    { path: ".env", reason: "hidden" },
    { path: "keys/id_rsa", reason: "credential" },
  ]);
});

test("nothing installed from the marketplace or a catalog is listed as the person's own", async () => {
  const pick = ports({
    spade: {
      bots: async () => [
        { id: "a_1", name: "Mine", task: "", face: undefined, fromMarket: false },
        { id: "a_2", name: "Installed", task: "", face: undefined, fromMarket: true },
      ],
      skills: async () => [{ id: "sks_1", name: "triage-mail", description: "" }],
    },
    aceSkills: async () => [
      {
        id: `skl_${"c".repeat(40)}`,
        name: "notes",
        title: undefined,
        description: "",
        folder: "/x",
      },
    ],
    plugins: async () => [
      { name: "calendar", version: "1.0.0", folder: "/y" },
      { name: "mail-tools", version: "1.0.0", folder: "/z" },
    ],
    installedFromMarket: market,
  });
  const titles = async (type: "spade-bot" | "spade-skill" | "spade-plugin") =>
    (await listPublishables(pick, type)).items.map((item) => item.title);
  expect(await titles("spade-bot")).toEqual(["Mine"]);
  expect(await titles("spade-skill")).toEqual(["notes"]);
  expect(await titles("spade-plugin")).toEqual(["mail-tools"]);
  await expect(
    readPicked(pick, "spade-plugin", { kind: "plugin", name: "calendar" }),
  ).rejects.toThrow(/isn't yours to publish/);
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
