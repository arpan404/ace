import { expect, test } from "vitest";
import { parseSpadeFolder, parseSpadeSkillStore, spadeSkillsOf } from "./workspace.ts";

test("a folder keeps the entries it can read and leaves out the rest", () => {
  const body = JSON.stringify({
    path: "",
    entries: [
      { name: "notes.md", path: "notes.md", kind: "file", size: 12, modified_at: 5 },
      { name: "drafts", path: "drafts", kind: "folder" },
      { name: "odd", path: "odd", kind: "socket" },
      { path: "nameless", kind: "file" },
    ],
  });

  expect(parseSpadeFolder(body)?.entries).toEqual([
    { name: "notes.md", path: "notes.md", kind: "file", size: 12, modifiedAt: 5 },
    { name: "drafts", path: "drafts", kind: "folder", size: 0, modifiedAt: undefined },
  ]);
  expect(parseSpadeFolder("not json")).toBeUndefined();
});

test("a bot's skills are the ones it wrote or loaded, each saying which", () => {
  const store = parseSpadeSkillStore(
    JSON.stringify({
      ace: true,
      skills: [
        { id: "a", name: "Release notes", origin: "spade", written_by: ["writer"] },
        { id: "b", name: "Changelog", origin: "ace", used_by: ["writer"] },
        { id: "c", name: "Charts", origin: "plugin", used_by: ["writer"] },
        { id: "d", name: "Inbox", origin: "ace", used_by: ["research"] },
        { id: "e", name: "Unknown", origin: "elsewhere", used_by: ["writer"] },
      ],
    }),
  );
  if (!store) throw new Error("no store");

  expect(spadeSkillsOf(store, "writer").map(({ skill, word }) => [skill.name, word])).toEqual([
    ["Release notes", "Wrote it"],
    ["Changelog", "Uses it"],
    ["Charts", "From a plugin"],
  ]);
});
