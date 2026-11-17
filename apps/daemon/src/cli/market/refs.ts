import {
  MarketEntryName,
  MarketEntryType,
  MarketPublisherName,
  MarketVersion,
} from "@ace/protocol/marketplace";
import { usageFailure } from "../output.ts";

/*
 * How the CLI names market things (ADR 0176 §11): an entry is `TYPE/NAME`, one version of it
 * `TYPE/NAME@VERSION`, and a publisher `@handle`. Pure.
 */

export interface EntryRef {
  readonly type: MarketEntryType;
  readonly name: string;
  readonly version?: string | undefined;
}

export type MarketRef =
  | ({ readonly kind: "entry" } & EntryRef)
  | { readonly kind: "publisher"; readonly handle: string };

const types = MarketEntryType.options.join(", ");

/** `suit/dusk-harbor`, `suit/dusk-harbor@1.2.0` or `@arpan`. */
export function parseRef(word: string, argument = "REF"): MarketRef {
  if (word.startsWith("@")) {
    const handle = word.slice(1);
    if (!MarketPublisherName.safeParse(handle).success)
      throw usageFailure(`${word} isn't a publisher's handle.`, {
        argument,
        hint: "A handle is lowercase letters, digits and single hyphens: @arpan.",
      });
    return { kind: "publisher", handle };
  }
  const match = /^([a-z-]+)\/([^@/]+)(?:@(.+))?$/.exec(word);
  if (!match)
    throw usageFailure(`${word} isn't a market entry.`, {
      argument,
      hint: "Name it as TYPE/NAME or TYPE/NAME@VERSION: suit/dusk-harbor@1.2.0.",
    });
  const [, type = "", name = "", version] = match;
  if (!MarketEntryType.safeParse(type).success)
    throw usageFailure(`${type} isn't a market type.`, { argument, hint: `Types: ${types}.` });
  if (!MarketEntryName.safeParse(name).success)
    throw usageFailure(`${name} isn't an entry name.`, {
      argument,
      hint: "Names are lowercase letters, digits and hyphens.",
    });
  if (version !== undefined && !MarketVersion.safeParse(version).success)
    throw usageFailure(`${version} isn't a version.`, {
      argument,
      hint: "A version is dotted numbers: 1.2.0.",
    });
  return { kind: "entry", type: MarketEntryType.parse(type), name, version };
}

/** An entry, never a publisher. */
export function parseEntry(word: string | undefined, argument = "REF"): EntryRef {
  if (word === undefined)
    throw usageFailure("Name the entry.", {
      code: "missing_argument",
      argument,
      hint: "As TYPE/NAME: suit/dusk-harbor.",
    });
  const ref = parseRef(word, argument);
  if (ref.kind === "publisher")
    throw usageFailure(`${word} is a publisher; name one of their entries.`, {
      argument,
      hint: "As TYPE/NAME: suit/dusk-harbor.",
    });
  return { type: ref.type, name: ref.name, version: ref.version };
}

/** One version: `TYPE/NAME@VERSION`, or `--version` beside `TYPE/NAME`. */
export function parseVersioned(
  word: string | undefined,
  version?: string,
  argument = "REF",
): EntryRef & { readonly version: string } {
  const entry = parseEntry(word, argument);
  const chosen = entry.version ?? version;
  if (chosen === undefined)
    throw usageFailure("Name the version.", {
      code: "missing_argument",
      argument,
      hint: `As ${entry.type}/${entry.name}@1.2.0.`,
    });
  if (!MarketVersion.safeParse(chosen).success)
    throw usageFailure(`${chosen} isn't a version.`, { argument, hint: "Like 1.2.0." });
  return { ...entry, version: chosen };
}

/** How the CLI writes one back: `suit/dusk-harbor@1.2.0`. */
export const refText = (ref: EntryRef): string =>
  `${ref.type}/${ref.name}${ref.version ? `@${ref.version}` : ""}`;
