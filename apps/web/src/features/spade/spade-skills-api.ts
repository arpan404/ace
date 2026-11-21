import { parseSpadeSkillStore, type SpadeSkillStore } from "@ace/ui-core/spade-chat";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * Spade's own skill store (ADR 0151, spade/docs/workspace.md): the skills it keeps, and Add to
 * ace's library for one written in Spade. An answer that doesn't parse throws, in words.
 */

export type { SpadeSkillStore, SpadeStoredSkill } from "@ace/ui-core/spade-chat";

export async function readSkillStore(
  target: SpadeTarget,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<SpadeSkillStore> {
  const parsed = parseSpadeSkillStore(await spadeHttp(target, "GET", "/v1/skills", options));
  if (!parsed) throw new Error("Spade's skills didn't make sense.");
  return parsed;
}

/** Creates the Spade skill in ace's library; Spade drops its own copy once ace has it. */
export async function addSkillToAce(target: SpadeTarget, id: string): Promise<void> {
  await spadeHttp(target, "POST", `/v1/skills/${segment(id)}/add-to-ace`);
}
