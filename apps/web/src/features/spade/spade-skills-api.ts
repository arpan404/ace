import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * Spade's own skill store (ADR 0151, spade/docs/workspace.md): the skills it keeps, and Add to
 * ace's library for one written in Spade. An answer that doesn't parse throws, in words.
 */

export interface SpadeStoredSkill {
  id: string;
  name: string;
  description: string;
  /** A copy of ace's library, written in Spade, or a plugin's. */
  origin: "ace" | "spade" | "plugin";
}

export interface SpadeSkillStore {
  skills: SpadeStoredSkill[];
  /** Spade is connected to ace now, so its library can take a skill. */
  ace: boolean;
}

const origins = new Set(["ace", "spade", "plugin"]);

function parseStore(body: string): SpadeSkillStore | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  if (!Array.isArray(fields.skills)) return undefined;
  const skills = fields.skills.flatMap((raw): SpadeStoredSkill[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const skill = raw as Record<string, unknown>;
    const { id, name, description, origin } = skill;
    if (typeof id !== "string" || typeof name !== "string" || typeof origin !== "string") return [];
    if (!origins.has(origin)) return [];
    return [
      {
        id,
        name,
        description: typeof description === "string" ? description : "",
        origin: origin as SpadeStoredSkill["origin"],
      },
    ];
  });
  return { skills, ace: fields.ace === true };
}

export async function readSkillStore(
  target: SpadeTarget,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<SpadeSkillStore> {
  const parsed = parseStore(await spadeHttp(target, "GET", "/v1/skills", options));
  if (!parsed) throw new Error("Spade's skills didn't make sense.");
  return parsed;
}

/** Creates the Spade skill in ace's library; Spade drops its own copy once ace has it. */
export async function addSkillToAce(target: SpadeTarget, id: string): Promise<void> {
  await spadeHttp(target, "POST", `/v1/skills/${segment(id)}/add-to-ace`);
}
