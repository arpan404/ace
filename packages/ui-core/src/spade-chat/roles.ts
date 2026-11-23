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

/** The most models a role's route holds (ADR 0205 §2). */
export const spadeMostInRoute = 4;

/**
 * Each role's route (ADR 0205 §2): its models in order, the first that can answer serving a
 * call; `main` is what each bot's own model falls back to. Missing where none is set.
 */
export type SpadeRoutes = Partial<Record<SpadeRole | "main", string[]>>;

/**
 * How hard a role's model thinks before it answers (ADR 0213). `provider` sends nothing, so the
 * endpoint's own default holds.
 */
export const spadeEfforts = ["provider", "off", "low", "medium", "high", "max"] as const;
export type SpadeEffort = (typeof spadeEfforts)[number];

export const spadeEffortNames: Record<SpadeEffort, string> = {
  provider: "Provider's thinking",
  off: "No thinking",
  low: "Low thinking",
  medium: "Medium thinking",
  high: "High thinking",
  max: "Most thinking",
};

const isEffort = (value: unknown): value is SpadeEffort =>
  typeof value === "string" && (spadeEfforts as readonly string[]).includes(value);

/** Each role's effort as set, `main` included; undefined where nothing is set. */
export type SpadeRoleEfforts = Partial<Record<SpadeRole | "main", SpadeEffort>>;

function roleEfforts(raw: unknown): SpadeRoleEfforts {
  const out: SpadeRoleEfforts = {};
  for (const [role, effort] of Object.entries(spadeRecord(raw) ?? {}))
    if ((role === "main" || isRole(role)) && isEffort(effort)) out[role] = effort;
  return out;
}

/** Whether a role's calls offer tools, so a model that can't call them can't serve it. */
export const spadeRoleNeedsTools = (role: SpadeRole | "main") =>
  role !== "title" && role !== "compact";

/** `GET /v1/models/roles`: the person's choices for every bot. */
export interface SpadeGlobalRoles {
  roles: SpadeRoleModels;
  /** Every role's route; a server before routes sends none, read from `roles`. */
  routes: SpadeRoutes;
  /** A failed helper runs once more on the bot's own model. */
  escalate: boolean;
  /** Each role's effort as set for every bot. */
  efforts: SpadeRoleEfforts;
  /** What each role thinks at with nothing set; a server before efforts sends none. */
  effortDefaults: SpadeRoleEfforts;
}

/** Where a bot's role model comes from: set on the bot, in Settings, a default, or its own. */
export type SpadeRoleSource = "bot" | "global" | "default" | "own";

/** `GET /v1/agents/{id}/models`: each role's model, what it follows, and this month's spend. */
export interface SpadeBotRoles {
  roles: {
    role: SpadeRole;
    model: string;
    source: SpadeRoleSource;
    monthMicros: number;
    /** The effort it runs at; undefined from a server before efforts. */
    effort: SpadeEffort | undefined;
  }[];
  /** The effort the bot's own turns run at; undefined from a server before efforts. */
  mainEffort: SpadeEffort | undefined;
  /** Efforts set on this bot, undefined where it follows Settings. */
  ownEfforts: SpadeRoleEfforts;
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
  const roles = roleModels(value.roles);
  return {
    roles,
    routes: routesOf(value.routes, roles),
    escalate: value.escalate === true,
    efforts: roleEfforts(value.efforts),
    effortDefaults: roleEfforts(value.effort_defaults),
  };
}

/** Routes as lists of models, never a subscription; a role with none reads its one model. */
function routesOf(raw: unknown, roles: SpadeRoleModels): SpadeRoutes {
  const out: SpadeRoutes = {};
  const record = spadeRecord(raw) ?? {};
  for (const role of [...spadeRoles, "main" as const]) {
    const list = record[role];
    const models = Array.isArray(list)
      ? list.filter(
          (model): model is string =>
            typeof model === "string" && model.length > 0 && !model.startsWith("cli:"),
        )
      : [];
    const one = role === "main" ? undefined : roles[role];
    const route = models.length ? models : one ? [one] : [];
    if (route.length) out[role] = route.slice(0, spadeMostInRoute);
  }
  return out;
}

const rowShape = z.object({
  role: z.string(),
  model: z.string().catch("").default(""),
  source: z.enum(["bot", "global", "default", "own"]).catch("default").default("default"),
  effort: z.enum(spadeEfforts).optional().catch(undefined),
});

export function parseSpadeBotRoles(body: string): SpadeBotRoles | undefined {
  const value = spadeRecord(spadeJson(body));
  if (!value || !Array.isArray(value.roles)) return undefined;
  const month = spadeRecord(spadeRecord(value.spend)?.month) ?? {};
  const overrides = spadeRecord(value.overrides);
  let mainEffort: SpadeEffort | undefined;
  const rows = value.roles.flatMap((raw) => {
    const row = rowShape.safeParse(raw);
    if (row.success && row.data.role === "main") mainEffort = row.data.effort;
    if (!row.success || !isRole(row.data.role)) return [];
    const spent = month[row.data.role];
    return [
      {
        role: row.data.role,
        model: row.data.model,
        source: row.data.source,
        monthMicros: typeof spent === "number" && spent > 0 ? spent : 0,
        effort: row.data.effort,
      },
    ];
  });
  rows.sort((a, b) => spadeRoles.indexOf(a.role) - spadeRoles.indexOf(b.role));
  const ownEscalate = overrides?.escalate;
  return {
    roles: rows,
    mainEffort,
    ownEfforts: roleEfforts(overrides?.efforts),
    own: roleModels(overrides?.roles),
    ownEscalate: typeof ownEscalate === "boolean" ? ownEscalate : undefined,
    escalate: value.escalate === true,
  };
}
