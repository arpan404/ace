import type { CommandSpec, NounSpec } from "./spec.ts";

/** An organization's host (ADR 0206 §4.2): its audit log, exported and checked. */
export const orgNouns: readonly NounSpec[] = [
  { name: "org", summary: "This machine as an organization's host", group: "spade-market" },
];

export const orgCommands: readonly CommandSpec[] = [
  {
    id: "org.audit.export",
    words: ["org", "audit", "export"],
    summary: "Write this org host's audit log as JSON Lines, with its signed checkpoints",
    description:
      "The log Spade keeps on this host (ADR 0206 §4.2): a header naming the organization, the host and its audit key, then each entry chained to the one before and each checkpoint the host signed. --from and --to take a date or milliseconds since 1970; without them, the whole log. Nothing in it is message text or a bot's arguments.",
    group: "spade-market",
    flags: [
      { name: "from", value: "WHEN", summary: "The first moment to include" },
      { name: "to", value: "WHEN", summary: "The last moment to include" },
      { name: "out", value: "FILE", summary: "Write it to FILE instead of standard output" },
    ],
    examples: [
      { command: "ace org audit export --out audit.jsonl", summary: "The whole log, to a file" },
      {
        command: "ace org audit export --from 2026-11-01 --to 2026-12-01",
        summary: "One month of it",
      },
    ],
    seeAlso: ["org audit verify"],
  },
  {
    id: "org.audit.verify",
    words: ["org", "audit", "verify"],
    summary: "Check an exported audit log's chain and signed checkpoints, offline",
    description:
      "Every entry must chain to the one before and every checkpoint must be signed by the audit key over the chain's head at that point, so an entry changed or removed before the last checkpoint no longer matches. --key is the host's audit key as the organization registered it (base64url); without it, this machine's Spade gives its own, which proves only that the file is this host's log as it is now.",
    group: "spade-market",
    args: [{ name: "FILE", summary: "A file ace org audit export wrote", required: true }],
    flags: [{ name: "key", value: "KEY", summary: "The host's registered audit key, base64url" }],
    examples: [
      {
        command:
          "ace org audit verify audit.jsonl --key 4YnbPAZLpD557zJQT9bDShIgb4lSIpvda8dHoDmZPM8",
        summary: "Against the key the organization registered",
      },
    ],
    exits: [{ code: 1, when: "the log doesn't verify" }],
    seeAlso: ["org audit export"],
  },
];
