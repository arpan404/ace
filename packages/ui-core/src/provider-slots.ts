import type { ProviderKind } from "@ace/protocol";
import { providerNames } from "./providers.ts";

/*
 * Which provider marks lead a row of agents: each provider once (three Claude subagents show one
 * Claude mark, whatever accounts they run on), in the order they were launched, in at most three
 * slots. Past three providers the first two show and the third slot says how many more. Pure.
 */

/** A provider, or none known (an agent whose provider ace hasn't learned yet). */
export type ProviderSlot = ProviderKind | undefined;

export interface ProviderSlots {
  /** The marks to draw, in launch order. */
  shown: readonly ProviderSlot[];
  /** Distinct providers past the shown ones ("+2"); 0 when every one shows. */
  more: number;
  /** The lead's accessible name: "Claude Code, Codex and 2 more". */
  label: string;
}

const slots = 3;

const nameOf = (provider: ProviderSlot) =>
  provider === undefined ? "Unknown agent" : providerNames[provider];

/** "a", "a and b", "a, b and c". */
function list(parts: readonly string[]): string {
  if (parts.length < 3) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The lead for agents launched with `providers`, oldest launch first. */
export function providerSlots(providers: readonly ProviderSlot[]): ProviderSlots {
  const distinct = [...new Set(providers)];
  const fits = distinct.length <= slots;
  const shown = fits ? distinct : distinct.slice(0, slots - 1);
  const more = distinct.length - shown.length;
  const names = shown.map(nameOf);
  return {
    shown,
    more,
    label: list(more ? [...names, `${more} more`] : names),
  };
}
