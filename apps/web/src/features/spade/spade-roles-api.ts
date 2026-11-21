import {
  parseSpadeBotRoles,
  parseSpadeGlobalRoles,
  type SpadeBotRoles,
  type SpadeGlobalRoles,
  type SpadeRole,
} from "@ace/ui-core/spade-chat";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * Models for other work (ADR 0162): the person's choice per role for every bot
 * (`/v1/models/roles`) and on one bot (`/v1/agents/{id}/models`). A role set to null follows
 * what is above it: Settings for a bot, the default for Settings.
 */

/** Every roles read; the global one under `[...rolesKey, machine]`, a bot's with its id after. */
export const rolesKey = ["spade", "roles"] as const;

/** A change: a role to a model, or null to follow; and the retry switch, null to follow. */
export interface SpadeRolesChange {
  /** A role to one model, its route (models in order, `main` included), or null to follow. */
  roles?: Partial<Record<SpadeRole | "main", string | string[] | null>>;
  escalate?: boolean | null;
}

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

export async function readGlobalRoles(
  target: SpadeTarget,
  signal?: AbortSignal,
): Promise<SpadeGlobalRoles> {
  const body = await spadeHttp(target, "GET", "/v1/models/roles", { signal });
  return sure(parseSpadeGlobalRoles(body), "models for other work");
}

export async function setGlobalRoles(
  target: SpadeTarget,
  change: SpadeRolesChange,
): Promise<SpadeGlobalRoles> {
  const body = await spadeHttp(target, "PUT", "/v1/models/roles", { body: change });
  return sure(parseSpadeGlobalRoles(body), "models for other work");
}

export async function readBotRoles(
  target: SpadeTarget,
  agent: string,
  signal?: AbortSignal,
): Promise<SpadeBotRoles> {
  const body = await spadeHttp(target, "GET", `/v1/agents/${segment(agent)}/models`, { signal });
  return sure(parseSpadeBotRoles(body), "models for other work");
}

export async function setBotRoles(
  target: SpadeTarget,
  agent: string,
  change: SpadeRolesChange,
): Promise<SpadeBotRoles> {
  const body = await spadeHttp(target, "PUT", `/v1/agents/${segment(agent)}/models`, {
    body: change,
  });
  return sure(parseSpadeBotRoles(body), "models for other work");
}
