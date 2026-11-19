import { grammarRelease as since } from "./flags.ts";
import { marketMaintainerCommands } from "./market-maintainer.ts";
import { marketPublishCommands } from "./market-publish.ts";
import type { CommandSpec, FlagSpec, NounSpec } from "./spec.ts";

/** The market for people, publishers and maintainers (ADR 0178 §11, §12). */
export const marketNouns: readonly NounSpec[] = [
  {
    name: "market",
    summary: "Find, install and publish Suits, skills and bots",
    group: "spade-market",
  },
];

const ref = { name: "REF", summary: "TYPE/NAME, such as suit/dusk-harbor", required: true };
const source: FlagSpec = { name: "source", value: "SOURCE", summary: "market or git:ID" };
const entryType: FlagSpec = {
  name: "type",
  value: "TYPE",
  summary: "suit, spade-skill, spade-plugin or spade-bot",
};
const sourceArg = { name: "SOURCE", summary: "The source's id: market or git:ID", required: true };

function sourceVerb(verb: string, summary: string, arg?: typeof sourceArg): CommandSpec {
  return {
    id: `market.source.${verb}`,
    words: ["market", "source", verb],
    summary,
    group: "spade-market",
    mutates: verb !== "list",
    nounDefault: verb === "list",
    output: "market.sources",
    ...(arg ? { args: [arg] } : {}),
  };
}

const peopleCommands: readonly CommandSpec[] = [
  {
    id: "market.discover",
    words: ["market", "discover"],
    summary: "What's featured, new and trending, and how to find more",
    group: "spade-market",
    nounDefault: true,
    output: "market.discover",
    description:
      "Every market command goes through this machine's daemon, so its sources, signature checks and ace account are used. Maintainer tools: ace help market-maintainer",
  },
  {
    id: "market.search",
    words: ["market", "search"],
    summary: "Search the market",
    group: "spade-market",
    args: [
      { name: "QUERY", summary: "Words to look for; everything when omitted", variadic: true },
    ],
    flags: [
      entryType,
      { name: "category", value: "CATEGORY", summary: "One category, such as dev-tools" },
      source,
      { name: "limit", value: "N", summary: "At most N entries (50)" },
    ],
    examples: [{ command: "ace market search linear --type spade-plugin", summary: "Plugins" }],
    output: "market.search",
  },
  {
    id: "market.show",
    words: ["market", "show"],
    summary: "An entry: what it is, who publishes it, its versions; or a publisher's page",
    group: "spade-market",
    args: [{ name: "REF", summary: "TYPE/NAME or @HANDLE", required: true }],
    flags: [source],
    output: "market.show",
  },
  {
    id: "market.install",
    words: ["market", "install"],
    summary: "Read an entry's review, then install it",
    description:
      "The review prints first: what it is, who published it, what it can run and reach, and what the scan found. Without a terminal, --yes installs with the review's defaults (no routines started). From an agent, installing is the person's: ace asks them in the thread.",
    group: "spade-market",
    args: [ref],
    flags: [{ name: "version", value: "VERSION", summary: "This version, not the newest" }, source],
    mutates: true,
    output: "market.install",
    exits: [
      { code: 2, when: "it needs your yes, or it's yours to do (from an agent)" },
      { code: 4, when: "the review is blocked" },
    ],
  },
  {
    id: "market.update",
    words: ["market", "update"],
    summary: "Read what changed, then update installed entries",
    group: "spade-market",
    args: [{ name: "REF", summary: "TYPE/NAME; every update with --all", variadic: true }],
    flags: [{ name: "all", summary: "Every entry with an update" }],
    mutates: true,
    output: "market.update",
    exits: [
      { code: 2, when: "it needs your yes, or it's yours to do (from an agent)" },
      { code: 4, when: "a review is blocked" },
    ],
  },
  {
    id: "market.remove",
    words: ["market", "remove"],
    summary: "Remove an installed entry",
    group: "spade-market",
    args: [ref],
    mutates: true,
    output: "market.done",
  },
  {
    id: "market.restore",
    words: ["market", "restore"],
    summary: "Turn a withdrawn or turned-off entry back on, from its pinned files",
    group: "spade-market",
    args: [ref],
    mutates: true,
    output: "market.done",
  },
  {
    id: "market.installed",
    words: ["market", "installed"],
    summary: "What's installed from the market",
    group: "spade-market",
    flags: [{ name: "updates", summary: "Only entries with an update" }],
    output: "market.installed",
  },
  sourceVerb("list", "Where entries come from"),
  {
    ...sourceVerb("add", "Add a git catalog as a source"),
    args: [{ name: "ADDRESS", summary: "The catalog's https address", required: true }],
  },
  sourceVerb("remove", "Remove a source", sourceArg),
  sourceVerb("on", "Turn a source on", sourceArg),
  sourceVerb("off", "Turn a source off", sourceArg),
  {
    ...sourceVerb("refresh", "Read sources again now"),
    args: [{ name: "SOURCE", summary: "One source; every source when omitted" }],
  },
  {
    id: "market.report",
    words: ["market", "report"],
    summary: "Report an entry to ace's maintainers",
    group: "spade-market",
    args: [{ name: "REF", summary: "TYPE/NAME or TYPE/NAME@VERSION", required: true }],
    flags: [
      {
        name: "reason",
        value: "REASON",
        summary: "What's wrong",
        choices: ["malware", "impersonation", "spam", "copyright", "harmful", "other"],
      },
      { name: "note", value: "TEXT", summary: "What you saw" },
    ],
    mutates: true,
    output: "market.done",
  },
];

/** Old `ace marketplace check` is `ace market check`. */
const checkCommand: CommandSpec = {
  id: "market.check",
  words: ["market", "check"],
  summary: "The market's checks on a folder, before publishing",
  description: "Runs here, with no account and no daemon.",
  group: "spade-market",
  offline: true,
  args: [{ name: "PATH", summary: "The folder; this one when omitted" }],
  flags: [
    entryType,
    { name: "name", value: "NAME", summary: "The entry's name; the folder's otherwise" },
  ],
  aliases: [{ words: ["marketplace", "check"], deprecatedSince: since }],
  output: "market.check",
  exits: [{ code: 1, when: "a check found a problem" }],
};

export const marketCommands: readonly CommandSpec[] = [
  ...peopleCommands,
  checkCommand,
  ...marketPublishCommands,
  ...marketMaintainerCommands,
];
