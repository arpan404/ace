import { describe, expect, it } from "vitest";
import { writeArchive } from "../archive.ts";
import { folder, samplePlugin, sampleRecipe, sampleSkill, sampleSuit } from "../testing.ts";
import { checkArchive, checkFiles } from "./index.ts";

describe("the shared checks", () => {
  it("pass a Suit that meets ace's static checks, with its listing words", () => {
    const checked = checkFiles("suit", "harbour-dusk", sampleSuit());
    expect(checked.problems).toEqual([]);
    expect(checked.listing).toMatchObject({
      title: "Harbour dusk",
      line: "Slate panels and a warm lamp.",
      categories: ["calm"],
    });
    expect(checked.inspection).toMatchObject({ type: "suit", passes: true, scenes: [] });
  });

  it("refuse a Suit whose suit.css names a class, with the line", () => {
    const files = [...sampleSuit(), ...folder({ "suit.css": "\n.sidebar { color: red; }\n" })];
    const checked = checkFiles("suit", "harbour-dusk", files);
    expect(checked.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "suit.css", line: 2 })]),
    );
  });

  it("refuse a Suit whose id isn't a Suit id", () => {
    expect(checkFiles("suit", "a.b", sampleSuit("a.b")).problems.length).toBeGreaterThan(0);
  });

  it("pass a skill and flag its scripts", () => {
    const checked = checkFiles(
      "spade-skill",
      "triage-mail",
      sampleSkill("triage-mail", { "scripts/run.sh*": "#!/bin/sh\n" }),
    );
    expect(checked.problems).toEqual([]);
    expect(checked.inspection).toMatchObject({ type: "spade-skill", flagged: ["scripts/run.sh"] });
  });

  it.each([
    ["no SKILL.md", folder({ "README.md": "x" })],
    ["another name in its frontmatter", sampleSkill("other")],
    ["a credential file", sampleSkill("triage-mail", { ".env": "A=1" })],
    [
      "a token in a file",
      sampleSkill("triage-mail", {
        "notes.md": "token ghp_REDACTEDREDACTEDREDACTEDREDACTEDREDACTED",
      }),
    ],
  ])("refuse a skill with %s", (_label, files) => {
    expect(checkFiles("spade-skill", "triage-mail", files).problems.length).toBeGreaterThan(0);
  });

  it("read a plugin's executions through ADR 0014's importer", () => {
    const checked = checkFiles("spade-plugin", "mail-tools", samplePlugin());
    expect(checked.problems).toEqual([]);
    expect(checked.inspection).toMatchObject({
      type: "spade-plugin",
      executions: [
        expect.objectContaining({ kind: "hook" }),
        expect.objectContaining({ kind: "stdio", name: "mail" }),
      ],
    });
  });

  it("refuse a plugin whose manifest names another plugin", () => {
    expect(checkFiles("spade-plugin", "other", samplePlugin()).problems).toEqual([
      expect.objectContaining({ message: expect.stringContaining("mail-tools") }),
    ]);
  });

  it("check a recipe's own skill folders as skills", () => {
    const good = sampleRecipe(
      { skills: ["skills/house-style"] },
      {
        "skills/house-style/SKILL.md":
          "---\nname: house-style\ndescription: How we write.\n---\nShort sentences.\n",
      },
    );
    const checked = checkFiles("spade-bot", "inbox", good);
    expect(checked.problems).toEqual([]);
    expect(checked.inspection).toMatchObject({
      type: "spade-bot",
      folders: [expect.objectContaining({ name: "house-style" })],
    });
    const bad = sampleRecipe(
      { skills: ["skills/house-style"] },
      { "skills/house-style/SKILL.md": "no frontmatter" },
    );
    expect(checkFiles("spade-bot", "inbox", bad).problems.length).toBeGreaterThan(0);
  });

  it("refuse a recipe holding files that aren't part of a recipe", () => {
    expect(
      checkFiles("spade-bot", "inbox", sampleRecipe({}, { "run.sh": "x" })).problems.length,
    ).toBeGreaterThan(0);
  });

  it("refuse ace plugins until their own decision", () => {
    expect(checkFiles("ace-plugin", "x", samplePlugin("x")).problems.length).toBeGreaterThan(0);
  });

  it("answer an archive that doesn't read with one problem", () => {
    const archive = writeArchive(sampleSkill());
    archive[200] = 99;
    expect(checkArchive("spade-skill", "triage-mail", archive).problems).toHaveLength(1);
  });

  it("refuse a market.json that doesn't fit its schema", () => {
    const files = [
      ...sampleSkill(),
      ...folder({ "market.json": JSON.stringify({ categories: ["a", "b", "c", "d"] }) }),
    ];
    expect(checkFiles("spade-skill", "triage-mail", files).problems).toEqual([
      expect.objectContaining({ path: "market.json" }),
    ]);
  });
});
