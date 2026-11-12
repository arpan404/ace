import {
  parseSpadeAgent,
  parseSpadeGroup,
  parseSpadeGroups,
  parseSpadeImport,
  parseSpadeTemplates,
  type SpadeAgent,
  type SpadeGroup,
  type SpadeTemplate,
} from "@ace/ui-core/spade-chat";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * Spade's team routes (ADR 0132, spade/docs/teams.md): groups, templates, and a bot's
 * duplicate, export and import. Each answer is parsed with `@ace/ui-core/spade-chat`; one that
 * doesn't parse throws, in words.
 */

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

type Signal = { signal?: AbortSignal | undefined };

export async function readGroups(target: SpadeTarget, options: Signal = {}) {
  return sure(parseSpadeGroups(await spadeHttp(target, "GET", "/v1/groups", options)), "groups");
}

/** A member as a group takes it: `machine` is the bot's host id, absent for the group's own. */
export interface SpadeMemberRef {
  agent: string;
  machine?: string;
}

export interface SpadeGroupDraft {
  name: string;
  members: SpadeMemberRef[];
  /** A member's agent id on the group's machine; Spade leads when absent. */
  lead?: string;
}

export async function createGroup(
  target: SpadeTarget,
  draft: SpadeGroupDraft,
): Promise<SpadeGroup> {
  const body = await spadeHttp(target, "POST", "/v1/groups", { body: draft });
  return sure(parseSpadeGroup(body), "new group");
}

export async function editGroup(
  target: SpadeTarget,
  id: string,
  change: Partial<SpadeGroupDraft>,
): Promise<SpadeGroup> {
  const body = await spadeHttp(target, "PATCH", `/v1/groups/${segment(id)}`, { body: change });
  return sure(parseSpadeGroup(body), "group");
}

/** Deletes the group and its transcript; its open asks are stopped. */
export async function deleteGroup(target: SpadeTarget, id: string): Promise<void> {
  await spadeHttp(target, "DELETE", `/v1/groups/${segment(id)}`);
}

/** Starts a run: the lead answers, or each member named with `@`. */
export async function postGroupMessage(
  target: SpadeTarget,
  id: string,
  text: string,
): Promise<void> {
  await spadeHttp(target, "POST", `/v1/groups/${segment(id)}/messages`, { body: { text } });
}

export async function stopGroup(target: SpadeTarget, id: string): Promise<void> {
  await spadeHttp(target, "POST", `/v1/groups/${segment(id)}/stop`);
}

export async function readTemplates(
  target: SpadeTarget,
  options: Signal = {},
): Promise<SpadeTemplate[]> {
  return sure(
    parseSpadeTemplates(await spadeHttp(target, "GET", "/v1/templates", options)),
    "templates",
  );
}

/** A copy of the bot: task, face, model, routines, apps and notes; never the conversation. */
export async function duplicateAgent(target: SpadeTarget, id: string): Promise<SpadeAgent> {
  const body = await spadeHttp(target, "POST", `/v1/agents/${segment(id)}/duplicate`, {
    body: {},
  });
  return sure(parseSpadeAgent(body), "copy");
}

/** The bot file, as Spade wrote it, to save as it is. */
export async function exportAgent(target: SpadeTarget, id: string): Promise<string> {
  return spadeHttp(target, "GET", `/v1/agents/${segment(id)}/export`);
}

/** Makes a bot from a bot file's text; the answer says what this machine left out. */
export async function importAgent(target: SpadeTarget, file: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("This file isn't a bot file.");
  const body = await spadeHttp(target, "POST", "/v1/agents/import", { body: parsed });
  return sure(parseSpadeImport(body), "imported bot");
}
