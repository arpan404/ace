import type { EntryRule, ScriptRule } from "./rule.ts";

/*
 * Data-flow rules (ADR 0173 §8): sensitive sources (the environment, env files, keychains, SSH
 * and cloud credentials, home files) followed through assignments, object fields and calls to
 * network sinks, for JavaScript and TypeScript through a real parser (`js-ast.ts`), and for
 * Python and shell where practical. Code that reads a sensitive source and reaches the network
 * where the flow can't be resolved is at least a warn, never a pass.
 */

export const flowRules: ScriptRule[] = [];

/** Whole-entry flow rules, such as a skill's hosts its listing doesn't declare. */
export const flowEntryRules: EntryRule[] = [];
