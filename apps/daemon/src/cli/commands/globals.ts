import type { FlagSpec } from "./spec.ts";

/** Flags every command takes, parsed before its own (ADR 0178 §2). */
export const globalFlags: readonly FlagSpec[] = [
  { name: "help", short: "h", summary: "This command's help" },
  { name: "json", summary: "Print one JSON value; implies --no-input" },
  { name: "jq", value: "EXPR", summary: "--json filtered through the installed jq" },
  { name: "quiet", short: "q", summary: "Print only identifiers, one per line, or nothing" },
  { name: "no-input", summary: "Never prompt; a missing argument is a usage error" },
  {
    name: "yes",
    short: "y",
    summary: "Answer yes to a confirmation; never answers a person-only action",
  },
  { name: "remote", value: "NAME", summary: "Run against a remote profile (ace remote list)" },
  { name: "timeout", value: "DURATION", summary: "Stop observing after this long: 30s, 10m, 0" },
  {
    name: "color",
    value: "WHEN",
    summary: "auto, always or never; auto follows the terminal and NO_COLOR",
    choices: ["auto", "always", "never"],
  },
  { name: "version", short: "v", summary: "The CLI's version" },
  // `-V` reads as version too; the legacy `--stream jsonl` is `--follow --json`.
  { name: "V", summary: "The CLI's version", hidden: true },
  { name: "stream", value: "jsonl", summary: "Same as --follow --json", hidden: true },
];

export const globalFlagNames: ReadonlySet<string> = new Set(globalFlags.map((flag) => flag.name));
