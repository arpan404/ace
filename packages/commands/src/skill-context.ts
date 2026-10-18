import { dirname } from "node:path";

/** A skill definition read through the catalog's secure, bounded file reader. */
export interface SkillSource {
  name: string;
  /** Absolute path of the SKILL.md file. */
  path: string;
  /** SKILL.md body with its frontmatter removed. */
  body: string;
}

/** Combined budget for skill bodies attached to one message. Each body is already capped. */
export const skillContextBudget = 256 * 1024;

/** The short reference left where the person placed the chip. */
export function skillReference(name: string): string {
  return `[skill: ${name}]`;
}

/**
 * A delimited block carrying a selected skill's instructions into the turn, for harnesses
 * with no verified native skill input. It names the file and its directory so relative
 * references in the body resolve, and places arguments where the skill asks for them.
 */
export function skillContext(skill: SkillSource, args: string): string {
  const directory = dirname(skill.path);
  const body = skill.body.includes("$ARGUMENTS")
    ? skill.body.replaceAll("$ARGUMENTS", args)
    : args
      ? `${skill.body.trimEnd()}\n\nARGUMENTS: ${args}`
      : skill.body;
  return [
    `<skill name=${JSON.stringify(skill.name)} path=${JSON.stringify(skill.path)}>`,
    `The person selected the ${JSON.stringify(skill.name)} skill for this message. Follow its instructions below. Resolve relative paths in it against ${JSON.stringify(directory)}.`,
    "",
    body.trim(),
    "</skill>",
  ].join("\n");
}
