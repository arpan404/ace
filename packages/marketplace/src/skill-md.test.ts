import { describe, expect, it } from "vitest";
import { checkFiles } from "./checks/index.ts";
import {
  exportProblems,
  exportSkillMd,
  importSkillMd,
  readSkillMd,
  skillMdProblems,
} from "./skill-md.ts";
import { folder } from "./testing.ts";

const md = (front: string, body = "# Triage mail\n\nRead the newest mail first.\n") =>
  `---\n${front}\n---\n${body}`;
const valid = "name: triage-mail\ndescription: Sorts a mail inbox into what needs a reply today.";

describe("SKILL.md front matter against the Agent Skills specification", () => {
  it.each([
    ["the two required fields", valid],
    [
      "every optional field the spec defines",
      `${valid}\nlicense: Apache-2.0\ncompatibility: Needs git and network access\nmetadata:\n  author: example\n  version: "1.0"\nallowed-tools: Bash(git:*) Read`,
    ],
    ["fields the spec doesn't define", `${valid}\ndisable-model-invocation: true\nmodel: fast`],
    ["a 64-character name in its own folder", `name: ${"a".repeat(64)}\ndescription: x`],
    ["a 1024-character description", `name: triage-mail\ndescription: ${"d".repeat(1024)}`],
  ])("accepts %s", (_label, front) => {
    const name = /name: (\S+)/.exec(front)?.[1] ?? "";
    expect(skillMdProblems(name, md(front))).toEqual([]);
  });

  it.each([
    ["no front matter", "# Triage mail\n", "must start with front matter"],
    ["front matter that doesn't read", md("name: [triage"), "doesn't read"],
    ["a missing name", md("description: Sorts mail."), "needs name: triage-mail"],
    ["a name with capitals", md("name: Triage-Mail\ndescription: x"), "lower-case"],
    ["a name with two hyphens together", md("name: triage--mail\ndescription: x"), "single"],
    ["a name starting with a hyphen", md("name: -triage\ndescription: x"), "not at its start"],
    ["a name over 64 characters", md(`name: ${"a".repeat(65)}\ndescription: x`), "over 64"],
    ["a name that isn't the folder's", md("name: sort-mail\ndescription: x"), "folder's name"],
    ["a missing description", md("name: triage-mail"), "needs a description"],
    ["an empty description", md('name: triage-mail\ndescription: "  "'), "needs a description"],
    [
      "a description over 1024 characters",
      md(`name: triage-mail\ndescription: ${"d".repeat(1025)}`),
      "over 1024",
    ],
    [
      "a compatibility over 500 characters",
      md(`${valid}\ncompatibility: ${"c".repeat(501)}`),
      "over 500",
    ],
    ["metadata that isn't a map", md(`${valid}\nmetadata: [a, b]`), "list of keys"],
    ["a metadata value that isn't text", md(`${valid}\nmetadata:\n  n: 3`), "metadata.n"],
    ["allowed-tools that isn't names", md(`${valid}\nallowed-tools: 3`), "allowed-tools"],
  ])("refuses %s, saying the rule", (_label, markdown, rule) => {
    const problems = skillMdProblems("triage-mail", markdown);
    expect(problems.map((problem) => problem.message).join("\n")).toContain(rule);
  });

  it("places a problem on the field's own line", () => {
    const problems = skillMdProblems("triage-mail", md("description: x\nname: Triage"));
    expect(problems.find((problem) => problem.message.includes("lower-case"))?.line).toBe(3);
  });

  it("keeps fields the spec doesn't define by name, and reads allowed-tools as names only", () => {
    const read = readSkillMd(md(`${valid}\nmodel: fast\nallowed-tools: Bash Read`));
    expect(read.unused).toEqual({ model: "fast" });
    expect(read.allowedTools).toEqual(["Bash", "Read"]);
  });

  it("refuses the same cases in the market's skill check", () => {
    const files = (markdown: string) => folder({ "SKILL.md": markdown });
    expect(checkFiles("spade-skill", "triage-mail", files(md(valid))).problems).toEqual([]);
    const refused = checkFiles(
      "spade-skill",
      "triage-mail",
      files(md(`name: triage-mail\ndescription: ${"d".repeat(1025)}`)),
    );
    expect(refused.problems.map((problem) => problem.message)).toContain(
      "description is over 1024 characters",
    );
    const kept = checkFiles(
      "spade-skill",
      "triage-mail",
      files(md(`${valid}\nlicense: MIT\nallowed-tools: Bash\nmodel: fast`)),
    );
    expect(kept.problems).toEqual([]);
    expect(kept.inspection).toMatchObject({
      license: "MIT",
      allowedTools: ["Bash"],
      unused: ["model"],
    });
  });
});

describe("a skill exported for other runtimes", () => {
  const original = md(
    `${valid}\nlicense: MIT\nallowed-tools: Bash Read\nmetadata:\n  author: example\ndisable-model-invocation: true\nargument-hint: "[folder]"\nmodel: fast`,
    "# Triage mail\n\n---\n\nKeep the --- above.\n",
  );

  it("passes the specification's validator, with Spade's facts under spade. keys", () => {
    const exported = exportSkillMd(original, { source: "spade" });
    expect(exportProblems("triage-mail", exported)).toEqual([]);
    const read = readSkillMd(exported);
    expect(read.unused).toEqual({});
    expect(read.metadata).toEqual({
      author: "example",
      "spade.field.disable-model-invocation": "true",
      "spade.field.argument-hint": '"[folder]"',
      "spade.field.model": '"fast"',
      "spade.version": "1",
      "spade.source": "spade",
    });
    expect(read.body).toBe("# Triage mail\n\n---\n\nKeep the --- above.\n");
  });

  it("fails the validator while a field the spec doesn't define stays at the top", () => {
    expect(exportProblems("triage-mail", original).map((p) => p.message)).toContain(
      "model isn't a field the specification has",
    );
  });

  it("round-trips: importing an export gives back the skill that was exported", () => {
    const exported = exportSkillMd(original, { source: "imported:/skills/triage-mail" });
    const imported = importSkillMd(exported);
    expect(imported.source).toBe("imported:/skills/triage-mail");
    expect(readSkillMd(imported.markdown)).toEqual(readSkillMd(original));
    expect(exportSkillMd(imported.markdown, { source: "x" })).toBe(
      exportSkillMd(original, { source: "x" }),
    );
  });

  it("imports a skill with none of Spade's keys byte for byte", () => {
    const plain = md(`${valid}\n# a comment stays\nmetadata:\n  author: example`);
    expect(importSkillMd(plain)).toEqual({ markdown: plain, source: undefined });
  });
});
