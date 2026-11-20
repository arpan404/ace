import {
  parseSpadeLearned,
  parseSpadeProvenance,
  type SpadeLearnedSource,
  type SpadeProvenance,
} from "@ace/ui-core/spade-chat";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * "Why do you think that?" (spade/docs/memory.md, Where it came from): where a note or a
 * knowledge page came from, the sources a bot learned from, and forgetting one of them whole.
 * First run's state lives here too: the About-you interview and the starter bots.
 */

/** A note's or a knowledge page's provenance. */
export type ProvenanceOf = { kind: "note"; id: string } | { kind: "entry"; id: string };

export async function readProvenance(
  target: SpadeTarget,
  of: ProvenanceOf,
  signal?: AbortSignal,
): Promise<SpadeProvenance> {
  const path =
    of.kind === "note"
      ? `/v1/notes/${segment(of.id)}/provenance`
      : `/v1/knowledge/${segment(of.id)}/provenance`;
  const parsed = parseSpadeProvenance(await spadeHttp(target, "GET", path, { signal }));
  if (!parsed) throw new Error("Spade's answer didn't make sense.");
  return parsed;
}

export async function readLearned(
  target: SpadeTarget,
  agent: string,
  signal?: AbortSignal,
): Promise<SpadeLearnedSource[]> {
  const body = await spadeHttp(target, "GET", `/v1/agents/${segment(agent)}/learned`, { signal });
  return parseSpadeLearned(body);
}

/** Forgets everything `agent` learned from `source`; answers how many notes and pages went. */
export async function forgetSource(
  target: SpadeTarget,
  agent: string,
  source: string,
): Promise<{ notes: number; entries: number }> {
  const body = await spadeHttp(target, "POST", `/v1/agents/${segment(agent)}/learned/forget`, {
    body: { source },
  });
  const parsed = JSON.parse(body) as { notes?: unknown; entries?: unknown };
  return {
    notes: typeof parsed.notes === "number" ? parsed.notes : 0,
    entries: typeof parsed.entries === "number" ? parsed.entries : 0,
  };
}

/** What became of each first-run step: `done`, `skipped`, or undefined while still to do. */
export interface SpadeOnboarding {
  aboutYou: "done" | "skipped" | undefined;
  starters: "done" | "skipped" | undefined;
}

const step = (value: unknown) => (value === "done" || value === "skipped" ? value : undefined);

export async function readOnboarding(
  target: SpadeTarget,
  signal?: AbortSignal,
): Promise<SpadeOnboarding> {
  const body = JSON.parse(await spadeHttp(target, "GET", "/v1/onboarding", { signal })) as Record<
    string,
    unknown
  >;
  return { aboutYou: step(body.about_you), starters: step(body.starters) };
}

export async function setOnboarding(
  target: SpadeTarget,
  change: { about_you?: "done" | "skipped" | null; starters?: "done" | "skipped" | null },
): Promise<void> {
  await spadeHttp(target, "PUT", "/v1/onboarding", { body: change });
}
