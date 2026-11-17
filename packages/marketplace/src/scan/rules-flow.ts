import { dataflow, type FlowHit } from "./dataflow.ts";
import { TRUNCATED_LEVEL } from "./fail-closed.ts";
import type { EntryRule, ScriptRule } from "./rule.ts";
import type { ScriptView } from "./script-view.ts";

/*
 * Data-flow rules (ADR 0173 §8): sensitive sources (the environment, env files, keychains, SSH
 * and cloud credentials, home files) followed through a file to a network sink (`dataflow.ts`),
 * for JavaScript and TypeScript through a real parser and for Python and shell by line patterns.
 * Code that reads a sensitive source and reaches the network, where the flow can't be ruled out,
 * is at least a warn, never a pass. A finding carries its own level, so the one analysis feeds
 * both a block rule and a warn rule; the result is cached per view so it runs once.
 */

const cache = new WeakMap<ScriptView, FlowHit[]>();
const hitsFor = (view: ScriptView): FlowHit[] => {
  let hits = cache.get(view);
  if (!hits) {
    hits = dataflow(view);
    cache.set(view, hits);
  }
  return hits;
};

/** One flow rule per level, reading the shared analysis; a warn holds a new publisher (strict). */
const flowAt = (level: "block" | "warn"): ScriptRule => ({
  kind: "script",
  id: level === "block" ? "sensitive-exfiltration" : "sensitive-exfiltration-maybe",
  check: "scripts",
  level,
  ...(level === "warn" ? { strict: true } : {}),
  find: (view) =>
    hitsFor(view)
      .filter((hit) => hit.level === level && !hit.truncated)
      .map((hit) =>
        hit.line ? { line: hit.line, message: hit.message } : { message: hit.message },
      ),
});

/** Code a cap cut the flow analysis short of: blocked as `scan-truncated` (fail-closed.ts). */
const flowTruncated: ScriptRule = {
  kind: "script",
  id: "scan-truncated",
  check: "scripts",
  level: TRUNCATED_LEVEL,
  find: (view) =>
    hitsFor(view)
      .filter((hit) => hit.truncated)
      .map((hit) =>
        hit.line ? { line: hit.line, message: hit.message } : { message: hit.message },
      ),
};

export const flowRules: ScriptRule[] = [flowAt("block"), flowAt("warn"), flowTruncated];

/** Hosts that never count as "reaching the internet". */
const local =
  /^(?:localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$|\.(?:invalid|example|test|localhost)$|^example\.(?:com|org|net)$/;

/**
 * A skill that talks to a host (ADR 0173 §8): shown and held for a new publisher, the way a
 * plugin's undeclared hosts are. A skill declares no hosts, so every host it reaches is noted.
 */
const skillHosts: EntryRule = {
  kind: "entry",
  id: "skill-host",
  check: "scripts",
  level: "note",
  strict: true,
  find(input, facts) {
    if (input.type !== "spade-skill") return [];
    return [...new Set(facts.hosts.map((host) => host.toLowerCase()))]
      .filter((host) => !local.test(host))
      .slice(0, 20)
      .map((host) => ({ message: `Its code talks to ${host}` }));
  },
};

export const flowEntryRules: EntryRule[] = [skillHosts];
