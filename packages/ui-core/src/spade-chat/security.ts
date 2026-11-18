import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";

/*
 * Spade's security boundaries as its API sends them (ADR 0167, spade/docs/security.md): the
 * machine's sandbox, and per bot its network policies, grants, consented folders, checkpoints and
 * egress log. Parsed leniently: a field this client can't read falls back to "not set", a grant
 * of a kind it doesn't know is kept as `other` with its raw fields.
 */

export type SpadeNetworkMode = "off" | "allow_list" | "open";

/** What a bot's commands (or its plugins) may reach through the egress proxy. */
export interface SpadeNetworkPolicy {
  mode: SpadeNetworkMode;
  /** The person's additions: `host`, `*.host` or either with `:port`. */
  allow: string[];
  /** Defaults the person removed. */
  dropped: string[];
}

/** Whether a bot's commands run in the sandbox or outside it, each one reviewed (ADR 0171). */
export type SpadeCommandsMode = "sandboxed" | "outside";

/** What every bot inherits unless it sets its own. */
export interface SpadeBotDefaults {
  commands: SpadeCommandsMode;
  network: SpadeNetworkPolicy;
  pluginNetwork: SpadeNetworkPolicy;
}

export interface SpadeSecurityMachine {
  /** The machine-wide defaults every bot inherits. */
  bots: SpadeBotDefaults;
  platform: string;
  /** `seatbelt`, `landlock`, `app_container` or `none`. */
  mechanism: string;
  /** Files and network both held, and the proxy listening: commands run without a review. */
  contained: boolean;
  /** Why a boundary isn't held, in Spade's words. */
  reason: string | undefined;
  proxyProblem: string | undefined;
  /** The hosts every listed-sites policy starts with. */
  defaults: string[];
  toolchainsFound: string[];
}

export type SpadeGrantScope =
  | { kind: "folder"; path: string; write: boolean }
  | { kind: "tool"; tool: string; arguments: Record<string, string> }
  | { kind: "git_push"; repo: string; branch: string }
  | { kind: "pr_comment"; repo: string; ownOnly: boolean }
  /** Driving one app or site (ADR 0171, amendment 3): its steps are reviewed without asking. */
  | { kind: "drive"; app: string }
  | { kind: "other"; name: string };

export type SpadeGrant = SpadeGrantScope & {
  id: string;
  /** `person`, or the parent bot that passed it down. */
  by: string;
  createdAt: number;
  raw: Record<string, unknown>;
};

export interface SpadeBotSecurity {
  contained: boolean;
  /** Effective: the bot's own, else the machine's. */
  commands: SpadeCommandsMode;
  /** Which of the three the bot sets itself; false inherits the machine's. */
  own: { commands: boolean; network: boolean; pluginNetwork: boolean };
  network: SpadeNetworkPolicy;
  pluginNetwork: SpadeNetworkPolicy;
  toolchains: string[];
  grants: SpadeGrant[];
  effectiveGrants: SpadeGrant[];
  folders: { grant: string; path: string; write: boolean }[];
}

export interface SpadeCheckpoint {
  id: string;
  at: number;
  /** `auto`, `person` or `before_restore`. */
  reason: string;
}

/** One line of a bot's egress log. */
export interface SpadeEgressEntry {
  at: number;
  connection: number;
  /** `opened`, `progress`, `closed`, `refused` or `failed`. */
  phase: string;
  host: string;
  port: number;
  allowed: boolean;
  reason: string | undefined;
  sent: number;
  received: number;
}

const text = z.string().catch("");
const texts = z.array(z.string()).catch([]);
const count = z.number().nonnegative().catch(0);

const policyShape = z.object({
  mode: z.enum(["off", "allow_list", "open"]).catch("allow_list"),
  allow: texts.default([]),
  dropped: texts.default([]),
});

function policy(raw: unknown, mode: SpadeNetworkMode): SpadeNetworkPolicy {
  const parsed = policyShape.safeParse(raw);
  return parsed.success ? parsed.data : { mode, allow: [], dropped: [] };
}

const commandsShape = z.enum(["sandboxed", "outside"]).catch("sandboxed");

const machineShape = z.object({
  bots: z.unknown().optional(),
  sandbox: z
    .object({ platform: text, mechanism: text, reason: z.string().nullish().catch(undefined) })
    .catch({ platform: "", mechanism: "none", reason: undefined }),
  proxy: z.object({ problem: z.string().nullish().catch(undefined) }).catch({}),
  contained: z.boolean().catch(false),
  defaults: texts.default([]),
  toolchains_found: texts.default([]),
});

/** `GET /security`; undefined when the body isn't an object. */
export function parseSpadeSecurityMachine(body: string): SpadeSecurityMachine | undefined {
  const raw = spadeRecord(spadeJson(body));
  const parsed = machineShape.safeParse(raw);
  if (!raw || !parsed.success) return undefined;
  const value = parsed.data;
  const bots = spadeRecord(value.bots);
  return {
    bots: {
      commands: commandsShape.parse(bots?.commands),
      network: policy(bots?.network, "allow_list"),
      pluginNetwork: policy(bots?.plugin_network, "open"),
    },
    platform: value.sandbox.platform,
    mechanism: value.sandbox.mechanism,
    contained: value.contained,
    reason: value.sandbox.reason ?? undefined,
    proxyProblem: value.proxy.problem ?? undefined,
    defaults: value.defaults,
    toolchainsFound: value.toolchains_found,
  };
}

const argumentsShape = z.record(z.string(), z.string()).catch({});

function scope(raw: Record<string, unknown>): SpadeGrantScope {
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  const word = (key: string) => (typeof raw[key] === "string" ? raw[key] : "");
  if (kind === "folder") return { kind, path: word("path"), write: raw.write === true };
  if (kind === "tool")
    return { kind, tool: word("tool"), arguments: argumentsShape.parse(raw.arguments) };
  if (kind === "git_push") return { kind, repo: word("repo"), branch: word("branch") };
  if (kind === "pr_comment") return { kind, repo: word("repo"), ownOnly: raw.own_only === true };
  if (kind === "drive") return { kind, app: word("app") };
  return { kind: "other", name: kind };
}

/** A stored grant; undefined without its id. */
export function parseSpadeGrant(value: unknown): SpadeGrant | undefined {
  const raw = spadeRecord(value);
  if (!raw || typeof raw.id !== "string" || !raw.id) return undefined;
  return {
    ...scope(raw),
    id: raw.id,
    by: typeof raw.by === "string" ? raw.by : "person",
    createdAt: typeof raw.created_at === "number" ? raw.created_at : 0,
    raw,
  };
}

/** `201 {grant}` from `POST /agents/{id}/grants`. */
export function parseSpadeGrantAnswer(body: string): SpadeGrant | undefined {
  return parseSpadeGrant(spadeRecord(spadeJson(body))?.grant);
}

const grantsOf = (value: unknown) =>
  (Array.isArray(value) ? value : [])
    .map(parseSpadeGrant)
    .filter((grant): grant is SpadeGrant => grant !== undefined);

const folderShape = z.object({
  grant: z.string(),
  path: z.string(),
  write: z.boolean().catch(false),
});

/** `GET /agents/{id}/security` and the network PUTs; undefined when the body isn't an object. */
export function parseSpadeBotSecurity(body: string): SpadeBotSecurity | undefined {
  const raw = spadeRecord(spadeJson(body));
  if (!raw) return undefined;
  const folders = (Array.isArray(raw.folders) ? raw.folders : []).flatMap((each) => {
    const parsed = folderShape.safeParse(each);
    return parsed.success ? [parsed.data] : [];
  });
  // An older Spade sends no `own`: everything reads as the bot's own, as it did.
  const own = spadeRecord(raw.own);
  const owns = (key: string) => (own ? own[key] !== false : true);
  return {
    contained: raw.contained === true,
    commands: commandsShape.parse(raw.commands),
    own: {
      commands: owns("commands"),
      network: owns("network"),
      pluginNetwork: owns("plugin_network"),
    },
    network: policy(raw.network, "allow_list"),
    pluginNetwork: policy(raw.plugin_network, "open"),
    toolchains: texts.parse(raw.toolchains ?? []),
    grants: grantsOf(raw.grants),
    effectiveGrants: grantsOf(raw.effective_grants),
    folders,
  };
}

const checkpointShape = z.object({ id: z.string().min(1), at: count, reason: text });

/** `GET /agents/{id}/checkpoints`, newest first; undefined without its list. */
export function parseSpadeCheckpoints(body: string): SpadeCheckpoint[] | undefined {
  const list = spadeRecord(spadeJson(body))?.checkpoints;
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((each) => {
    const parsed = checkpointShape.safeParse(each);
    return parsed.success ? [parsed.data] : [];
  });
}

const entryShape = z.object({
  at: count,
  connection: count.default(0),
  phase: text.default(""),
  host: z.string(),
  port: count,
  allowed: z.boolean().catch(false),
  reason: z.string().nullish().catch(undefined),
  sent: count,
  received: count,
});

/** `GET /agents/{id}/security/egress`, oldest first as sent; undefined without its list. */
export function parseSpadeEgress(body: string): SpadeEgressEntry[] | undefined {
  const list = spadeRecord(spadeJson(body))?.entries;
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((each) => {
    const parsed = entryShape.safeParse(each);
    if (!parsed.success) return [];
    const { reason, ...entry } = parsed.data;
    return [{ ...entry, reason: reason ?? undefined }];
  });
}
