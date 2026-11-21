import type { MarketProblem } from "@ace/protocol/marketplace";
import type { ArchiveFile } from "../archive.ts";
import { text } from "../listing.ts";
import { secretFileProblem, secretValueProblems } from "../secrets.ts";
import { readSkillMd, skillMdProblems, unusedFields } from "../skill-md.ts";

/** A skill's facts for its review: its SKILL.md and which of its files are scripts or binaries. */
export interface SkillInspection {
  type: "spade-skill";
  skillName: string;
  description: string;
  skillMd: string;
  /** Paths that are executable or not text. */
  flagged: string[];
  license: string | undefined;
  compatibility: string | undefined;
  /** `allowed-tools`: shown, never a grant (ADR 0202 decision 4). */
  allowedTools: string[];
  /** Front matter fields the specification doesn't define: kept, not used. */
  unused: string[];
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
 * A skill folder: `SKILL.md` at its root meeting the Agent Skills specification (ADR 0202 §1:
 * its name, the folder's, and its description, license, compatibility, metadata and
 * allowed-tools as the spec has them), and no secrets. `name` is the name the skill must carry.
 * Fields the spec doesn't define are kept and listed, never refused.
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
  problems.push(...skillMdProblems(name, markdown, `${prefix}SKILL.md`));
  const read = readSkillMd(markdown);
  return {
    inspection: {
      type: "spade-skill",
      skillName: name,
      description: read.description.slice(0, 1024),
      skillMd: markdown,
      flagged: files.filter(flaggedFile).map((file) => file.path),
      license: read.license?.slice(0, 200),
      compatibility: read.compatibility?.slice(0, 500),
      allowedTools: read.allowedTools.slice(0, 64).map((tool) => tool.slice(0, 120)),
      unused: unusedFields(read)
        .slice(0, 64)
        .map((field) => field.slice(0, 120)),
    },
    problems,
  };
}
