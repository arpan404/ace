import type { MarketScanCheckId, MarketScanLevel } from "@ace/protocol/marketplace";
import type { ScanInput } from "./index.ts";
import type { ScriptView } from "./script-view.ts";

/*
 * The rule framework (ADR 0174 §8) the script and whole-entry checks plug into. A `ScriptRule`
 * reads one script view (a skill script, a plugin command, a hook, a recipe-bundled skill) and
 * returns a finding per match; an `EntryRule` reads the whole entry and the facts a step gathered
 * (hosts seen in code, and the like). The rule tables are separate files so each table is edited
 * on its own; the scanner just runs them. Pure.
 */

/** Facts a step gathers for the whole-entry rules: hosts code talks to, and the like. */
export interface ScanFacts {
  /** URL hosts seen in any script's code, lower-cased, de-duplicated. */
  hosts: string[];
}

/** One match a rule found: a line (when it has one) and the one-sentence finding. */
export interface RuleHit {
  line?: number;
  message: string;
}

/** A rule over one script view. `find` returns a hit per match; each becomes a finding. */
export interface ScriptRule {
  kind: "script";
  id: string;
  check: "scripts" | "plugin" | "recipe";
  level: MarketScanLevel;
  /** Holds a new publisher's version even as a note (ADR 0174 §9). */
  strict?: boolean;
  find(view: ScriptView): RuleHit[];
}

/** One match a whole-entry rule found: an optional path and line, and the sentence. */
export interface EntryHit {
  path?: string;
  line?: number;
  message: string;
}

/** A rule over the whole entry and the gathered facts (plugin manifests, recipes, declared hosts). */
export interface EntryRule {
  kind: "entry";
  id: string;
  check: MarketScanCheckId;
  level: MarketScanLevel;
  strict?: boolean;
  find(input: ScanInput, facts: ScanFacts): EntryHit[];
}
