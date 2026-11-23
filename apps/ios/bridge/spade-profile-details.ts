import {
  parseSpadePersonality,
  spadeModelLabel,
  spadeMoney,
  spadeNetworkModes,
  spadePrivateHost,
  spadeQuietPersonality,
  spadeRoleNames,
  spadeTones,
  type SpadeAgent,
  type SpadeBotRoles,
  type SpadeBotSecurity,
  type SpadeCheckpoint,
  type SpadeModelSources,
  type SpadeNetworkMode,
  type SpadeNetworkPolicy,
  type SpadeRole,
  type SpadeTone,
} from "@ace/ui-core/spade-chat";
import { SpadeRequestError } from "@ace/ui-core/spade-chat";

/*
 * The sections of a bot's profile the person edits on the iPhone, as web's: its personality,
 * the models for its other work (ADR 0162), its notifications (ADR 0195), what its commands and
 * plugins may reach (ADR 0167), its spending (ADR 0135) and its checkpoints (ADR 0167). Each
 * section reads and writes on its own; these turn Spade's answers into the rows Swift draws, and
 * a change the person made into what Spade takes. Pure.
 */

export interface SpadePersonalityRow {
  /** Null leaves the manner to the bot ("Its own way"). */
  tone: SpadeTone | null;
  humour: boolean;
  emoji: boolean;
  tones: { value: SpadeTone; label: string; says: string }[];
}

export function spadePersonalityRow(agent: SpadeAgent): SpadePersonalityRow {
  const stored = parseSpadePersonality(agent.raw.personality) ?? spadeQuietPersonality;
  return {
    tone: stored.tone ?? null,
    humour: stored.humour,
    emoji: stored.emoji,
    tones: spadeTones.map(({ value, label, says }) => ({ value, label, says })),
  };
}

/** This month's spend with today's under it; null while Spade hasn't recorded any. */
export function spadeSpendingRow(agent: SpadeAgent): { month: string; today: string } | null {
  const spending = agent.spending;
  if (!spending) return null;
  return { month: spadeMoney(spending.monthMicros), today: spadeMoney(spending.todayMicros) };
}

export interface SpadeRoleRow {
  role: SpadeRole;
  title: string;
  /** "$0.42 this month". */
  spent: string;
  /** Nothing is set on this bot: it follows Settings. */
  follows: boolean;
  /** What is set on this bot, or "" while it follows. */
  value: string;
  /** The model it runs on either way, in words. */
  words: string;
}

/** Each of the bot's five roles, as its fold under the model shows them. */
export function spadeRoleRows(roles: SpadeBotRoles, sources: SpadeModelSources): SpadeRoleRow[] {
  return roles.roles.map((row) => {
    const own = roles.own[row.role];
    const shown = spadeModelLabel(sources, row.model, "Spade's default");
    return {
      role: row.role,
      title: spadeRoleNames[row.role],
      spent: `${spadeMoney(row.monthMicros)} this month`,
      follows: !own,
      value: own ?? "",
      words: shown.source ? `${shown.name} · ${shown.source}` : shown.name,
    };
  });
}

export interface SpadeReachRow {
  /** Whether it reaches the person outside Spade; on follows Spade's own settings. */
  notify: boolean;
  /** During quiet hours, approvals and questions: as in Settings, notify, or wait for the brief. */
  approvals: "inherit" | "notify" | "wait";
}

export function spadeReachRow(own: { notify: unknown; approvals: unknown }): SpadeReachRow {
  return {
    notify: own.notify !== false,
    approvals: own.approvals === "notify" || own.approvals === "wait" ? own.approvals : "inherit",
  };
}

/** What a change on the Notifications section sends: on follows Spade's setting (`null`). */
export function spadeReachChange(change: {
  notify?: boolean | undefined;
  approvals?: SpadeReachRow["approvals"] | undefined;
}): { notify?: false | null; approvals?: "notify" | "wait" | null } {
  return {
    ...(change.notify === undefined ? {} : { notify: change.notify ? null : false }),
    ...(change.approvals === undefined
      ? {}
      : { approvals: change.approvals === "inherit" ? null : change.approvals }),
  };
}

export type SpadeNetworkFor = "commands" | "plugins";

export interface SpadePolicyRow {
  which: SpadeNetworkFor;
  title: string;
  mode: SpadeNetworkMode;
  /** The bot sets it itself; false is the machine's (`place`). */
  own: boolean;
  /** The listed sites: the person's own, then the defaults, each removable or put back. */
  sites: { entry: string; line: string | null; action: "Remove" | "Put back" }[];
  /** Hosts on a private network it may reach. */
  hosts: string[];
}

export interface SpadeNetworkRow {
  /** "this Mac", or "this computer". */
  place: string;
  modes: { value: SpadeNetworkMode; label: string }[];
  policies: SpadePolicyRow[];
}

function policyRow(
  which: SpadeNetworkFor,
  policy: SpadeNetworkPolicy,
  own: boolean,
  defaults: readonly string[],
): SpadePolicyRow {
  const mine = policy.allow.filter((entry) => !spadePrivateHost(entry));
  return {
    which,
    title: which === "commands" ? "Commands reach" : "Plugins reach",
    mode: policy.mode,
    own,
    sites: [
      ...mine.map((entry) => ({ entry, line: null, action: "Remove" as const })),
      ...defaults.map((entry) => {
        const dropped = policy.dropped.includes(entry);
        return {
          entry,
          line: dropped ? "Default, removed" : "Default",
          action: dropped ? ("Put back" as const) : ("Remove" as const),
        };
      }),
    ],
    hosts: policy.allow.filter(spadePrivateHost),
  };
}

export function spadeNetworkRow(
  security: SpadeBotSecurity,
  defaults: readonly string[],
  place: string,
): SpadeNetworkRow {
  return {
    place,
    modes: spadeNetworkModes.map(({ value, label }) => ({ value, label })),
    policies: [
      policyRow("commands", security.network, security.own.network, defaults),
      policyRow("plugins", security.pluginNetwork, security.own.pluginNetwork, defaults),
    ],
  };
}

/** One change the person made to a rule. */
export type SpadeNetworkChange =
  | { mode: SpadeNetworkMode }
  | { add: string }
  /** A listed site or private host: one of the person's goes, a default is dropped or put back. */
  | { toggle: string };

/** The rule `policy` becomes after `change`; `defaults` are the machine's listed sites. */
export function spadeNextPolicy(
  policy: SpadeNetworkPolicy,
  change: SpadeNetworkChange,
  defaults: readonly string[],
): SpadeNetworkPolicy {
  if ("mode" in change) return { ...policy, mode: change.mode };
  if ("add" in change) {
    const entry = change.add.trim();
    return entry && !policy.allow.includes(entry)
      ? { ...policy, allow: [...policy.allow, entry] }
      : policy;
  }
  const entry = change.toggle;
  if (policy.allow.includes(entry))
    return { ...policy, allow: policy.allow.filter((each) => each !== entry) };
  if (!defaults.includes(entry)) return policy;
  return policy.dropped.includes(entry)
    ? { ...policy, dropped: policy.dropped.filter((each) => each !== entry) }
    : { ...policy, dropped: [...policy.dropped, entry] };
}

const reasons: Record<string, string> = {
  auto: "Automatic",
  person: "Taken by you",
  before_restore: "Before a restore",
};

export interface SpadeCheckpointRow {
  id: string;
  /** When it was taken, in ms. */
  at: number;
  reason: string;
}

/** The most checkpoints the section lists; Spade keeps a few dozen at most. */
const checkpointsShown = 30;

/** Newest first, as Spade keeps them, each with why it was taken. */
export function spadeCheckpointRows(checkpoints: readonly SpadeCheckpoint[]): SpadeCheckpointRow[] {
  return checkpoints.slice(0, checkpointsShown).map((checkpoint) => ({
    id: checkpoint.id,
    at: checkpoint.at,
    reason: reasons[checkpoint.reason] ?? checkpoint.reason,
  }));
}

/** Why Spade refused a restore, in the profile's words: the bot busy, or a restore running. */
export function spadeRestoreRefusal(name: string, error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof SpadeRequestError && error.status === 409) {
    if (message.includes("services")) return `${name}'s services are running. Stop them first.`;
    if (message.includes("being restored")) return "A restore is already running.";
    return `${name} is working. Stop it first.`;
  }
  return message || "Try again.";
}
