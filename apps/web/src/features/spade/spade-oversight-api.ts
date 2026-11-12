import {
  parseSpadeActivity,
  parseSpadeAgentOversight,
  parseSpadeOversight,
  spadeActivitySearch,
  type SpadeActivityQuery,
} from "@ace/ui-core/spade-chat";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * Spending caps, the model review and each bot's activity log (ADR 0135,
 * spade/docs/oversight.md), each answer parsed with `@ace/ui-core/spade-chat`. An answer that
 * doesn't parse throws, in words.
 */

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

/** Every oversight read; one machine's under `[...oversightKey, machine key]`. */
export const oversightKey = ["spade", "oversight"] as const;

export async function readOversight(target: SpadeTarget, signal?: AbortSignal) {
  const body = await spadeHttp(target, "GET", "/v1/oversight", { signal });
  return sure(parseSpadeOversight(body), "oversight");
}

export interface SpadeOversightChange {
  time_zone?: string;
  review_default?: boolean;
  review_model?: string | null;
}

export async function setOversight(target: SpadeTarget, change: SpadeOversightChange) {
  const body = await spadeHttp(target, "PUT", "/v1/oversight", { body: change });
  return sure(parseSpadeOversight(body), "oversight");
}

export async function readAgentOversight(target: SpadeTarget, agent: string, signal?: AbortSignal) {
  const path = `/v1/agents/${segment(agent)}/oversight`;
  return sure(parseSpadeAgentOversight(await spadeHttp(target, "GET", path, { signal })), "caps");
}

/** Caps in micros; `null` clears a cap, or makes the bot follow the review default. */
export interface SpadeAgentOversightChange {
  daily_cap_micros?: number | null;
  monthly_cap_micros?: number | null;
  review?: boolean | null;
}

export async function setAgentOversight(
  target: SpadeTarget,
  agent: string,
  change: SpadeAgentOversightChange,
) {
  const path = `/v1/agents/${segment(agent)}/oversight`;
  const body = await spadeHttp(target, "PUT", path, { body: change });
  return sure(parseSpadeAgentOversight(body), "caps");
}

export async function readActivity(
  target: SpadeTarget,
  agent: string,
  query: SpadeActivityQuery,
  signal?: AbortSignal,
) {
  const path = `/v1/agents/${segment(agent)}/activity${spadeActivitySearch(query)}`;
  return sure(parseSpadeActivity(await spadeHttp(target, "GET", path, { signal })), "activity");
}
