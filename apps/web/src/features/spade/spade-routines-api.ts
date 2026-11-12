import {
  parseSpadeHeartbeat,
  parseSpadeRoutine,
  parseSpadeRoutines,
  type SpadeTrigger,
} from "@ace/ui-core/spade-chat";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * A bot's routines and heartbeat (ADR 0129, spade/docs/routines.md), each answer parsed with
 * `@ace/ui-core/spade-chat`. An answer that doesn't parse throws, in words.
 */

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

/** The person's own time zone, which schedules they write are meant in. */
export const personZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export interface SpadeRoutineDraft {
  name: string;
  instruction: string;
  trigger: SpadeTrigger;
}

export async function readRoutines(target: SpadeTarget, agent: string, signal?: AbortSignal) {
  const path = `/v1/agents/${segment(agent)}/routines`;
  return sure(parseSpadeRoutines(await spadeHttp(target, "GET", path, { signal })), "routines");
}

export async function addRoutine(target: SpadeTarget, agent: string, draft: SpadeRoutineDraft) {
  const path = `/v1/agents/${segment(agent)}/routines`;
  const body = { ...draft, time_zone: personZone() };
  return sure(parseSpadeRoutine(await spadeHttp(target, "POST", path, { body })), "routine");
}

export async function editRoutine(
  target: SpadeTarget,
  id: string,
  change: Partial<SpadeRoutineDraft> & { paused?: boolean },
) {
  const path = `/v1/routines/${segment(id)}`;
  // A schedule the person rewrites is meant in their zone now.
  const body = change.trigger ? { ...change, time_zone: personZone() } : change;
  return sure(parseSpadeRoutine(await spadeHttp(target, "PATCH", path, { body })), "routine");
}

export async function removeRoutine(target: SpadeTarget, id: string): Promise<void> {
  await spadeHttp(target, "DELETE", `/v1/routines/${segment(id)}`);
}

export async function runRoutine(target: SpadeTarget, id: string): Promise<void> {
  await spadeHttp(target, "POST", `/v1/routines/${segment(id)}/run`);
}

export async function readHeartbeat(target: SpadeTarget, agent: string, signal?: AbortSignal) {
  const path = `/v1/agents/${segment(agent)}/heartbeat`;
  return sure(parseSpadeHeartbeat(await spadeHttp(target, "GET", path, { signal })), "heartbeat");
}

export interface SpadeHeartbeatDraft {
  enabled?: boolean;
  every_minutes?: number;
  checklist?: string;
  quiet?: { start: string; end: string } | null;
}

export async function saveHeartbeat(
  target: SpadeTarget,
  agent: string,
  change: SpadeHeartbeatDraft,
) {
  const path = `/v1/agents/${segment(agent)}/heartbeat`;
  const body = { ...change, time_zone: personZone() };
  return sure(parseSpadeHeartbeat(await spadeHttp(target, "PUT", path, { body })), "heartbeat");
}
