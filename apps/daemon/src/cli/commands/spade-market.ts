import { grammarRelease as since, idempotencyKey } from "./flags.ts";
import type { ArgSpec, CommandSpec, FlagSpec, NounSpec } from "./spec.ts";

/** Spade, Beta switches, automations and the market (ADR 0176 §7, §11, §12). */
export const spadeMarketNouns: readonly NounSpec[] = [
  { name: "spade", summary: "Spade, ace's assistant", group: "spade-market" },
  { name: "feature", summary: "Beta features", group: "spade-market" },
  { name: "automation", summary: "Automations", group: "spade-market" },
  {
    name: "market",
    summary: "Find, install and publish Suits, skills and bots",
    group: "spade-market",
  },
];

const featureArg = {
  name: "FEATURE",
  summary: "spade or marketplace",
  required: true,
} as const;
const url: FlagSpec = { name: "url", value: "URL", summary: "Another market origin" };
const key: FlagSpec = { name: "key", value: "KEY_FILE", summary: "The signing key file" };
const reason: FlagSpec = { name: "reason", value: "TEXT", summary: "Why; publishers see it" };

/** The signer's tools (ADR 0168 §6–7, 0174 §10), hidden and kept apart (decision 7). */
function maintainer(
  verb: string,
  summary: string,
  flags: readonly FlagSpec[],
  args: readonly ArgSpec[] = [],
): CommandSpec {
  return {
    id: `market.maintainer.${verb}`,
    words: ["market", "maintainer", verb],
    summary,
    description: "Maintainer tool: needs ACE_MARKET_SIGNER_TOKEN and a signing key.",
    group: "spade-market",
    hidden: true,
    offline: true,
    args,
    flags,
    aliases: [{ words: ["market", verb], deprecatedSince: since }],
  };
}
const rest = (name: string, summary: string) => [{ name, summary, variadic: true }];

export const spadeMarketCommands: readonly CommandSpec[] = [
  {
    id: "spade.on",
    words: ["spade", "on"],
    summary: "Turn Spade on",
    group: "spade-market",
    offline: true,
    mutates: true,
  },
  {
    id: "spade.off",
    words: ["spade", "off"],
    summary: "Turn Spade off",
    group: "spade-market",
    offline: true,
    mutates: true,
  },
  {
    id: "feature.list",
    words: ["feature", "list"],
    summary: "Beta features and whether each is on",
    group: "spade-market",
    offline: true,
    nounDefault: true,
    aliases: [{ words: ["features"], quiet: true }],
  },
  {
    id: "feature.on",
    words: ["feature", "on"],
    summary: "Turn a Beta feature on",
    group: "spade-market",
    offline: true,
    mutates: true,
    args: [featureArg],
    aliases: [{ words: ["features", "on"], deprecatedSince: since }],
  },
  {
    id: "feature.off",
    words: ["feature", "off"],
    summary: "Turn a Beta feature off",
    group: "spade-market",
    offline: true,
    mutates: true,
    args: [featureArg],
    aliases: [{ words: ["features", "off"], deprecatedSince: since }],
  },
  {
    id: "automation.list",
    words: ["automation", "list"],
    summary: "Your automations",
    group: "spade-market",
    nounDefault: true,
    aliases: [{ words: ["automations"], quiet: true }],
  },
  {
    id: "automation.run",
    words: ["automation", "run"],
    summary: "Run an automation now",
    group: "spade-market",
    mutates: true,
    args: [{ name: "AUTOMATION", summary: "The automation id", required: true }],
    flags: [
      { name: "variables", value: "@FILE", summary: "Its variables, from a JSON file" },
      idempotencyKey,
    ],
  },
  {
    id: "market.check",
    words: ["market", "check"],
    summary: "The market's checks on a folder, before publishing",
    group: "spade-market",
    offline: true,
    args: [{ name: "PATH", summary: "The folder; this one when omitted" }],
    flags: [
      { name: "type", value: "TYPE", summary: "suit, spade-skill, spade-plugin or spade-bot" },
      { name: "name", value: "NAME", summary: "The entry's name, when the folder doesn't say" },
    ],
    aliases: [{ words: ["marketplace", "check"], deprecatedSince: since }],
    exits: [{ code: 1, when: "a check found a problem" }],
  },
  maintainer(
    "keygen",
    "Make a signing key and print its public half",
    [{ name: "id", value: "ID", summary: "The key's id" }],
    [{ name: "KEY_FILE", summary: "Where to write the key", required: true }],
  ),
  maintainer("sign", "Re-scan, then sign, hold or block what waits", [key, url]),
  maintainer(
    "review",
    "What waits for a maintainer, or one version's review",
    [
      key,
      url,
      { name: "by-ace", summary: "Mark it reviewed by ace" },
      { name: "not-reviewed", summary: "Mark it not reviewed" },
      { name: "show", summary: "Show the version" },
      { name: "approve", summary: "Approve the held version" },
      { name: "block", value: "REASON", summary: "Block the version" },
    ],
    [{ name: "REF", summary: "TYPE/NAME@VERSION" }],
  ),
  maintainer("feature", "Set the featured list", [url], rest("REF", "TYPE/NAME, in order")),
  maintainer(
    "revoke",
    "Withdraw bytes wherever they're listed",
    [key, url, reason],
    [{ name: "HASH", summary: "The bytes' hash", required: true }],
  ),
  maintainer(
    "reports",
    "Open reports, or resolve one",
    [
      url,
      { name: "state", value: "STATE", summary: "dismissed, kept, withdrawn or blocked" },
      { name: "note", value: "TEXT", summary: "A note for the reporter" },
    ],
    rest("ARGS", "resolve ID"),
  ),
  maintainer(
    "collection",
    "Curated collections",
    [
      url,
      { name: "title", value: "TEXT", summary: "The collection's title" },
      { name: "line", value: "TEXT", summary: "Its one line" },
    ],
    rest("ARGS", "list | put ID TYPE/NAME… | remove ID"),
  ),
  maintainer(
    "publisher",
    "Suspend, restore or withdraw a publisher",
    [
      url,
      key,
      { name: "suspend", value: "REASON", summary: "Suspend the publisher" },
      { name: "restore", summary: "Restore the publisher" },
      { name: "withdraw-all", value: "REASON", summary: "Withdraw everything they published" },
    ],
    [{ name: "HANDLE", summary: "The publisher's handle", required: true }],
  ),
  ...(["block", "block-file", "block-pattern"] as const).map((verb) =>
    maintainer(
      verb,
      verb === "block"
        ? "Block bytes by hash"
        : verb === "block-file"
          ? "Block a file by SHA-256"
          : "Block a pattern",
      [url, key, reason],
      [{ name: "SUBJECT", summary: "The hash or pattern", required: true }],
    ),
  ),
  maintainer("appeals", "Open appeals", [url]),
  maintainer(
    "appeal",
    "Answer an appeal",
    [
      url,
      { name: "answer", value: "TEXT", summary: "Your answer to the publisher" },
      { name: "approve", summary: "Approve the appeal" },
      { name: "keep", summary: "Keep the decision" },
    ],
    [{ name: "ID", summary: "The appeal id", required: true }],
  ),
  ...(["verify", "unverify"] as const).map((verb) =>
    maintainer(
      verb,
      verb === "verify" ? "Verify a publisher" : "Remove a publisher's verification",
      [url, key, reason],
      [{ name: "HANDLE", summary: "The publisher's handle", required: true }],
    ),
  ),
  maintainer(
    "official",
    "Add or remove an official account",
    [url, key],
    [
      { name: "ACTION", summary: "add or remove", required: true },
      { name: "ACCOUNT", summary: "The account id", required: true },
    ],
  ),
];
