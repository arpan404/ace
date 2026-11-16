import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";

/*
 * Models for a bot's other work (ADR 0162): the helpers it starts, the check of done, the review
 * of its steps, summaries and titles, each on a model the person picks in Settings for every bot
 * or on one bot. Spend by role is information only. Parsed leniently: a role this client
 * doesn't know is left out.
 */

/** The roles the person picks a model for, in the order they show. */
export const spadeRoles = ["helper", "verify", "review", "compact", "title"] as const;
export type SpadeRole = (typeof spadeRoles)[number];

export const spadeRoleNames: Record<SpadeRole, string> = {
  helper: "Helpers",
  verify: "Checking done",
  review: "Reviewing steps",
  compact: "Summaries",
  title: "Titles",
};

const isRole = (value: string): value is SpadeRole =>
  (spadeRoles as readonly string[]).includes(value);

/** Each role's model as the person set it, undefined where they didn't. */
export type SpadeRoleModels = Partial<Record<SpadeRole, string>>;

/** `GET /v1/models/roles`: the person's choices for every bot. */
export interface SpadeGlobalRoles {
  roles: SpadeRoleModels;
  /** A failed helper runs once more on the bot's own model. */
  escalate: boolean;
}

/** Where a bot's role model comes from: set on the bot, in Settings, a default, or its own. */
export type SpadeRoleSource = "bot" | "global" | "default" | "own";

/** `GET /v1/agents/{id}/models`: each role's model, what it follows, and this month's spend. */
export interface SpadeBotRoles {
  roles: { role: SpadeRole; model: string; source: SpadeRoleSource; monthMicros: number }[];
  /** What is set on this bot, undefined where it follows Settings. */
  own: SpadeRoleModels;
  /** Its own escalate choice, undefined where it follows Settings. */
  ownEscalate: boolean | undefined;
  escalate: boolean;
}

function roleModels(raw: unknown): SpadeRoleModels {
  const out: SpadeRoleModels = {};
  for (const [role, model] of Object.entries(spadeRecord(raw) ?? {}))
    if (isRole(role) && typeof model === "string" && model) out[role] = model;
  return out;
}

export function parseSpadeGlobalRoles(body: string): SpadeGlobalRoles | undefined {
  const value = spadeRecord(spadeJson(body));
  if (!value) return undefined;
  return { roles: roleModels(value.roles), escalate: value.escalate === true };
}

const rowShape = z.object({
  role: z.string(),
  model: z.string().catch("").default(""),
  source: z.enum(["bot", "global", "default", "own"]).catch("default").default("default"),
});

export function parseSpadeBotRoles(body: string): SpadeBotRoles | undefined {
  const value = spadeRecord(spadeJson(body));
  if (!value || !Array.isArray(value.roles)) return undefined;
  const month = spadeRecord(spadeRecord(value.spend)?.month) ?? {};
  const overrides = spadeRecord(value.overrides);
  const rows = value.roles.flatMap((raw) => {
    const row = rowShape.safeParse(raw);
    if (!row.success || !isRole(row.data.role)) return [];
    const spent = month[row.data.role];
    return [
      {
        role: row.data.role,
        model: row.data.model,
        source: row.data.source,
        monthMicros: typeof spent === "number" && spent > 0 ? spent : 0,
      },
    ];
  });
  rows.sort((a, b) => spadeRoles.indexOf(a.role) - spadeRoles.indexOf(b.role));
  const ownEscalate = overrides?.escalate;
  return {
    roles: rows,
    own: roleModels(overrides?.roles),
    ownEscalate: typeof ownEscalate === "boolean" ? ownEscalate : undefined,
    escalate: value.escalate === true,
  };
}
