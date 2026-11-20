import { z } from "zod";

/*
 * A bot linked to an agent package (ADR 0200 §3.9), as Spade's agent view carries it under
 * `package`: which package and version, the one before an update, a withdrawal's reason, and each
 * declared effect with the person's switch. Read leniently: a field this client doesn't know is
 * ignored, and an unreadable link reads as none.
 */

export interface SpadePackageEffect {
  key: string;
  effect: string;
  hosts: readonly string[];
  why: string;
  on: boolean;
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
  effects: z
    .array(
      z.object({
        key: text,
        effect: text,
        hosts: z.array(text).catch([]).default([]),
        why: text.catch(""),
        on: z.boolean().catch(false),
      }),
    )
    .catch([])
    .default([]),
});

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
    effects: link.effects,
  };
}
