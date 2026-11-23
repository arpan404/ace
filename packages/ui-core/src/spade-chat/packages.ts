import { z } from "zod";

/*
 * A bot linked to an agent package (ADR 0200 §3.9), as Spade's agent view carries it under
 * `package`: which package and version, the one before an update, a withdrawal's reason, an
 * update held until the bot is still, and each declared effect with the person's switch. Read
 * leniently: a field this client doesn't know is ignored, and an unreadable link reads as none.
 * Also the words every client says a declared effect in, and which switches an install review
 * starts on (ADR 0200 §3.4).
 */

/** A grant a declared effect asks for (ADR 0167 §5). */
export type SpadeEffectGrant =
  | { kind: "drive_site"; host: string }
  | { kind: "drive_app"; app: string }
  /** One tool, with each named argument matching its pattern. */
  | { kind: "tool"; tool: string; arguments?: Readonly<Record<string, string>> | undefined };

/** A declared effect, as much of it as its words need. */
export interface SpadeDeclaredEffect {
  effect: string;
  hosts?: readonly string[] | undefined;
  grant?: SpadeEffectGrant | undefined;
}

export interface SpadePackageEffect extends SpadeDeclaredEffect {
  key: string;
  hosts: readonly string[];
  why: string;
  on: boolean;
}

/** The person-only effects: declared, they can ask; they never run on a switch. */
const asksEachTime = new Set(["send_as_person", "pay", "change_access"]);

/** Whether a declared effect still goes to the person every time it is used. */
export const decidedEachTime = (row: Pick<SpadeDeclaredEffect, "effect">) =>
  asksEachTime.has(row.effect);

/** One declared effect as its switch's words: "Reaches api.example-fares.com". */
export function effectWords(row: SpadeDeclaredEffect): string {
  if (row.hosts?.length) return `Reaches ${row.hosts.join(", ")}`;
  switch (row.grant?.kind) {
    case "drive_site":
      return `Acts in pages on ${row.grant.host} as you`;
    case "drive_app":
      return `Acts in ${row.grant.app} as you`;
    case "tool":
      return `Uses ${row.grant.tool} without asking`;
    case undefined:
      break;
  }
  switch (row.effect) {
    case "network":
      return "Changes things outside its own folder, in your apps and online";
    case "publish":
      return "Publishes and posts";
    case "send_as_person":
      return "Can ask you to send things in your name";
    case "pay":
      return "Can ask you to pay";
    case "change_access":
      return "Can ask you to change sign-ins or access";
    default:
      return row.effect;
  }
}

/**
 * What a declared effect is held to beyond its words, one line each: a tool grant's argument
 * patterns ("path matching docs/*"). Empty when it is held to nothing more. Every place that
 * asks the person to turn one on says these too, so they never grant more than they read.
 */
export function effectLimits(row: SpadeDeclaredEffect): string[] {
  if (row.grant?.kind !== "tool") return [];
  return Object.entries(row.grant.arguments ?? {})
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, pattern]) => `${name} matching ${pattern}`);
}

/**
 * A declared effect's words from its key alone (Spade's `effect:hosts:a,b`,
 * `effect:drive_site:host`, `effect:drive_app:app`, `effect:tool:name`, or the effect's name),
 * for one a plan names that the version in hand no longer declares.
 */
export function effectKeyWords(key: string): string {
  const [effect = key, kind, ...rest] = key.split(":");
  const value = rest.join(":");
  switch (kind) {
    case "hosts":
      return effectWords({ effect, hosts: value.split(",") });
    case "drive_site":
      return effectWords({ effect, grant: { kind: "drive_site", host: value } });
    case "drive_app":
      return effectWords({ effect, grant: { kind: "drive_app", app: value } });
    case "tool":
      return effectWords({ effect, grant: { kind: "tool", tool: value } });
    default:
      return effectWords({ effect });
  }
}

/**
 * Whether an install review starts this switch on. A package by ace starts with what it
 * declares. One from anyone else starts with only reaching the hosts it names: acting in pages
 * or apps as the person, using a tool without asking, publishing, reaching anywhere, and the
 * person-only effects (sending as them, paying, changing access) start off, for the person to
 * turn on. Those person-only ones still ask each time when on.
 */
export function effectStartsOn(row: SpadeDeclaredEffect, byAce: boolean): boolean {
  if (byAce) return true;
  return row.effect === "network" && row.grant === undefined && (row.hosts?.length ?? 0) > 0;
}

export interface SpadePackage {
  source: string;
  name: string;
  version: string;
  /** The version it had before its last update or rollback. */
  previous: string | undefined;
  /** Its version was withdrawn: the bot is paused with this reason. */
  withdrawn: string | undefined;
  /** An update to this version is under way. */
  updating: string | undefined;
  /** An update to this version waits for the bot to finish its turn. */
  held: string | undefined;
  /**
   * A bot made from one of ace's templates (`source: "spade"`): the newer version of it this
   * Spade ships, offered for the person to review. Never applied on its own.
   */
  templateUpdate: string | undefined;
  /** The package's hash: what a switch is turned on, so a newer version's isn't. */
  hash: string | undefined;
  effects: readonly SpadePackageEffect[];
  /** Effects Spade sent that this client couldn't read: what it lists is not all it declares. */
  effectsDropped: number;
  /** Typed calls the person's other bots may make to it (ADR 0200 §7). */
  contracts: readonly SpadeContract[];
}

/** A contract a bot's package publishes, as its profile lists it. */
export interface SpadeContract {
  name: string;
  summary: string;
  /** Effects a call to it may use beyond reading and the bot's own things. */
  effects: readonly string[];
}

const text = z.string().max(2000);
/** As long as a plan may name one (`PackagePlan`), so no key it can name is unreadable here. */
const effectKey = z.string().max(2100);
const effectShape = z.object({
  key: effectKey,
  effect: text,
  hosts: z.array(text).catch([]).default([]),
  grant: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("drive_site"), host: text }),
      z.object({ kind: z.literal("drive_app"), app: text }),
      z.object({
        kind: z.literal("tool"),
        tool: text,
        arguments: z.record(z.string().max(200), text).optional(),
      }),
    ])
    .nullish()
    .catch(undefined)
    .transform((grant) => grant ?? undefined),
  why: text.catch(""),
  on: z.boolean().catch(false),
});
const shape = z.object({
  source: text,
  name: text,
  version: text,
  hash: text.optional().catch(undefined),
  previous: z.object({ version: text }).nullish().catch(undefined),
  withdrawn: z.object({ reason: text }).nullish().catch(undefined),
  updating: text.nullish().catch(undefined),
  held: z.object({ version: text }).nullish().catch(undefined),
  template_update: z.object({ version: text }).nullish().catch(undefined),
  // Each effect read on its own: one this client can't read leaves the rest (`effectsDropped`).
  effects: z.array(z.unknown()).catch([]).default([]),
  contracts: z
    .array(
      z.object({
        name: text,
        summary: text.catch(""),
        effects: z.array(text).catch([]).default([]),
      }),
    )
    .catch([])
    .default([]),
});

/**
 * Whether a bot is a development bot (ADR 0200 §9): linked to a package with no market
 * signature, a folder on its machine that `ace bot dev` keeps it updated from. It shows
 * "Development" and is never updated or rolled back through the Marketplace.
 */
export const spadeIsDevelopment = (link: SpadePackage | undefined): boolean =>
  link?.source === "local";

/** The `package` of a Spade agent; undefined for a bot that isn't linked to one. */
export function parseSpadePackage(raw: unknown): SpadePackage | undefined {
  const read = shape.safeParse(raw);
  if (!read.success) return undefined;
  const link = read.data;
  const effects = link.effects.flatMap((each) => {
    const effect = effectShape.safeParse(each);
    return effect.success ? [effect.data] : [];
  });
  return {
    source: link.source,
    name: link.name,
    version: link.version,
    previous: link.previous?.version,
    withdrawn: link.withdrawn?.reason,
    updating: link.updating ?? undefined,
    held: link.held?.version,
    templateUpdate: link.template_update?.version,
    hash: link.hash,
    effects,
    effectsDropped: link.effects.length - effects.length,
    contracts: link.contracts,
  };
}

/**
 * "From flight-watcher 1.0.0 in the Marketplace.", and when an update waits for the bot to be
 * still: "Updates when Flight watcher is done with its turn."
 */
export function spadePackageSentence(link: SpadePackage, bot: string): string {
  if (spadeIsDevelopment(link)) {
    const held = link.held ? ` Its latest save applies when ${bot} is done with its turn.` : "";
    return `Updated from its package folder on this machine with ace bot dev.${held}`;
  }
  const from = `${link.name} ${link.version}`;
  if (link.withdrawn) return `Paused: ${from} was withdrawn. ${link.withdrawn}`;
  if (link.updating) return `Updating from ${from} to ${link.updating}.`;
  const held = link.held ? ` Updates when ${bot} is done with its turn.` : "";
  if (link.source === "spade") return `From ace's ${link.name} template ${link.version}.${held}`;
  const where = link.source === "market" ? "the Marketplace" : "a catalog you added";
  return `From ${from} in ${where}.${held}`;
}

const incomingShape = z.object({ incoming: z.boolean() });

/**
 * `GET /v1/agents/{id}/contracts`'s switch (ADR 0200 §7): whether the person's other bots may
 * call this bot's contracts; undefined when the answer doesn't read.
 */
export function parseSpadeIncoming(body: string): boolean | undefined {
  try {
    const read = incomingShape.safeParse(JSON.parse(body));
    return read.success ? read.data.incoming : undefined;
  } catch {
    return undefined;
  }
}

/** A contract's effects in words, for its row: "It may reach outside its folder while answering." */
export function spadeContractEffects(effects: readonly string[]): string {
  const words: Record<string, string> = {
    network: "reach outside its folder",
    publish: "publish",
    send_as_person: "ask you to send in your name",
    pay: "ask you to pay",
    change_access: "ask you to change sign-ins",
  };
  const said = effects.map((effect) => words[effect] ?? effect);
  if (!said.length) return "It only reads and uses its own things while answering.";
  const list = said.length === 1 ? said[0] : `${said.slice(0, -1).join(", ")} and ${said.at(-1)}`;
  return `It may ${list} while answering.`;
}
