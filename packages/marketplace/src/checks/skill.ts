import type { MarketProblem } from "@ace/protocol/marketplace";
import type { ArchiveFile } from "../archive.ts";
import { frontmatter, text } from "../listing.ts";
import { secretFileProblem, secretValueProblems } from "../secrets.ts";

/** A skill's facts for its review: its SKILL.md and which of its files are scripts or binaries. */
export interface SkillInspection {
  type: "spade-skill";
  skillName: string;
  description: string;
  skillMd: string;
  /** Paths that are executable or not text. */
  flagged: string[];
}

const textLike = /\.(?:md|mdc|markdown|txt|json|ya?ml|toml|csv|tsv|html?|css|xml|svg)$/i;

/** Executable, or not a text format: the person should see these flagged. */
export function flaggedFile(file: ArchiveFile): boolean {
  return file.executable || !textLike.test(file.path) || text(file.content) === undefined;
}

/** Secrets in a folder: credential-named files, and secret-shaped values in its text files. */
export function folderSecretProblems(files: readonly ArchiveFile[], prefix = ""): MarketProblem[] {
  const problems: MarketProblem[] = [];
  for (const file of files) {
    const named = secretFileProblem(prefix + file.path);
    if (named) problems.push(named);
    const content = text(file.content);
    if (content !== undefined) problems.push(...secretValueProblems(content, prefix + file.path));
  }
  return problems;
}

/**
 * An ADR 0103 skill folder: `SKILL.md` at its root with frontmatter naming it and saying what it
 * does, and no secrets. `name` is the name the skill must carry.
 */
export function checkSkill(
  name: string,
  files: readonly ArchiveFile[],
  prefix = "",
): { inspection: SkillInspection | undefined; problems: MarketProblem[] } {
  const problems = folderSecretProblems(files, prefix);
  const skill = files.find((file) => file.path === "SKILL.md");
  const markdown = text(skill?.content);
  if (markdown === undefined) {
    problems.push({
      path: `${prefix}SKILL.md`,
      message: `${prefix}SKILL.md is missing or isn't text`,
    });
    return { inspection: undefined, problems };
  }
  const { data } = frontmatter(markdown);
  const declared = typeof data["name"] === "string" ? data["name"] : undefined;
  const description = typeof data["description"] === "string" ? data["description"].trim() : "";
  if (declared !== name)
    problems.push({
      path: `${prefix}SKILL.md`,
      line: 1,
      message: `SKILL.md's frontmatter must say name: ${name}`,
    });
  if (!description)
    problems.push({
      path: `${prefix}SKILL.md`,
      line: 1,
      message: "SKILL.md's frontmatter needs a description",
    });
  else if (description.length > 1024)
    problems.push({
      path: `${prefix}SKILL.md`,
      line: 1,
      message: "The description is over 1024 characters",
    });
  return {
    inspection: {
      type: "spade-skill",
      skillName: name,
      description: description.slice(0, 1024),
      skillMd: markdown,
      flagged: files.filter(flaggedFile).map((file) => file.path),
    },
    problems,
  };
}
