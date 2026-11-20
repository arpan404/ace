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
  | { kind: "tool"; tool: string };

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
  effects: readonly SpadePackageEffect[];
}

const text = z.string().max(2000);
const shape = z.object({
  source: text,
  name: text,
  version: text,
  previous: z.object({ version: text }).nullish().catch(undefined),
  withdrawn: z.object({ reason: text }).nullish().catch(undefined),
  updating: text.nullish().catch(undefined),
  held: z.object({ version: text }).nullish().catch(undefined),
  effects: z
    .array(
      z.object({
        key: text,
        effect: text,
        hosts: z.array(text).catch([]).default([]),
        grant: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("drive_site"), host: text }),
            z.object({ kind: z.literal("drive_app"), app: text }),
            z.object({ kind: z.literal("tool"), tool: text }),
          ])
          .nullish()
          .catch(undefined)
          .transform((grant) => grant ?? undefined),
        why: text.catch(""),
        on: z.boolean().catch(false),
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
  return {
    source: link.source,
    name: link.name,
    version: link.version,
    previous: link.previous?.version,
    withdrawn: link.withdrawn?.reason,
    updating: link.updating ?? undefined,
    held: link.held?.version,
    effects: link.effects,
  };
}
