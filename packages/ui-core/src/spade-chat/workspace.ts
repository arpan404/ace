import { spadeJson, spadeRecord } from "./json.ts";

/*
 * A bot's workspace (ADR 0130, spade/docs/workspace.md) and Spade's skill store (ADR 0151) as
 * every client reads them. Parsed leniently: an entry this client can't read is left out.
 */

export interface SpadeFileEntry {
  name: string;
  /** Relative to the workspace, with `/`. */
  path: string;
  kind: "folder" | "file" | "link";
  size: number;
  modifiedAt: number | undefined;
}

export interface SpadeWorkspaceFolder {
  path: string;
  entries: SpadeFileEntry[];
  truncated: boolean;
}

/** Spade's own folder at the top of a workspace: its bookkeeping, not the bot's files. */
export const spadeOwnFolder = ".spade";

const fileKinds = new Set(["folder", "file", "link"]);
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const num = (value: unknown) => (typeof value === "number" ? value : undefined);
const isKind = (kind: string): kind is SpadeFileEntry["kind"] => fileKinds.has(kind);

/** `GET /v1/agents/{id}/workspace?path=`; undefined when the body has no entries. */
export function parseSpadeFolder(body: string): SpadeWorkspaceFolder | undefined {
  const fields = spadeRecord(spadeJson(body));
  if (!fields || !Array.isArray(fields.entries)) return undefined;
  const entries = fields.entries.flatMap((raw): SpadeFileEntry[] => {
    const entry = spadeRecord(raw);
    const name = str(entry?.name);
    const path = str(entry?.path);
    const kind = str(entry?.kind);
    if (!entry || !name || path === undefined || !kind || !isKind(kind)) return [];
    return [{ name, path, kind, size: num(entry.size) ?? 0, modifiedAt: num(entry.modified_at) }];
  });
  return { path: str(fields.path) ?? "", entries, truncated: fields.truncated === true };
}

export interface SpadeStoredSkill {
  id: string;
  name: string;
  description: string;
  /** A copy of ace's library, written in Spade, or a plugin's. */
  origin: "ace" | "spade" | "plugin";
  /** Bot ids whose saved proposals wrote or changed it, sorted. */
  writtenBy: string[];
  /** Bot ids that have loaded it, sorted. */
  usedBy: string[];
}

export interface SpadeSkillStore {
  skills: SpadeStoredSkill[];
  /** Spade is connected to ace now, so its library can take a skill. */
  ace: boolean;
}

const origins = new Set(["ace", "spade", "plugin"]);
const isOrigin = (origin: string): origin is SpadeStoredSkill["origin"] => origins.has(origin);

/** A list of bot ids; none when the field is missing or isn't a list. */
const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

/** `GET /v1/skills`; undefined when the body has no list. */
export function parseSpadeSkillStore(body: string): SpadeSkillStore | undefined {
  const fields = spadeRecord(spadeJson(body));
  if (!fields || !Array.isArray(fields.skills)) return undefined;
  const skills = fields.skills.flatMap((raw): SpadeStoredSkill[] => {
    const skill = spadeRecord(raw);
    const id = str(skill?.id);
    const name = str(skill?.name);
    const origin = str(skill?.origin);
    if (!skill || id === undefined || name === undefined || !origin || !isOrigin(origin)) return [];
    return [
      {
        id,
        name,
        description: str(skill.description) ?? "",
        origin,
        writtenBy: ids(skill.written_by),
        usedBy: ids(skill.used_by),
      },
    ];
  });
  return { skills, ace: fields.ace === true };
}

/** The skills a bot wrote or loaded, with how it came to have each: `Wrote it`, `Uses it`. */
export function spadeSkillsOf(
  store: SpadeSkillStore,
  bot: string,
): { skill: SpadeStoredSkill; word: string }[] {
  return store.skills
    .filter((skill) => skill.usedBy.includes(bot) || skill.writtenBy.includes(bot))
    .map((skill) => ({
      skill,
      word: skill.writtenBy.includes(bot)
        ? "Wrote it"
        : skill.origin === "plugin"
          ? "From a plugin"
          : "Uses it",
    }));
}
