import { grammarRelease as since } from "./flags.ts";
import type { CommandSpec, FlagSpec } from "./spec.ts";

/** `ace storage …` and `ace config …` (ADR 0176 §7, §8). Data only. */

const kinds: readonly FlagSpec[] = [
  { name: "threads", summary: "Settled threads' history" },
  { name: "worktrees", summary: "Worktrees of settled threads" },
  { name: "artifacts", summary: "Screenshots, recordings and other artifacts" },
  { name: "logs", summary: "Old logs" },
  { name: "attachments", summary: "Attached files" },
  { name: "caches", summary: "Caches ace can rebuild" },
];
const planFlags: readonly FlagSpec[] = [
  ...kinds,
  { name: "older-than", value: "DURATION", summary: "Only what's older than this, like 30d" },
  {
    name: "force-item",
    value: "ID",
    repeat: true,
    summary: "Also remove this protected item from the plan (needs --dry-run first)",
  },
  { name: "retention", value: "@FILE", summary: "Days to keep per kind, from a JSON file" },
  // The first CLI's spellings, kept for the deprecation window.
  { name: "kinds", value: "KIND,…", summary: "Kinds as one list", hidden: true },
  { name: "force-items", value: "JSON", summary: "Protected items as JSON", hidden: true },
];
const planArg = { name: "PLAN", summary: "The plan id ace storage plan printed", required: true };

export const storageCommands: readonly CommandSpec[] = [
  {
    id: "storage.usage",
    words: ["storage", "usage"],
    summary: "What ace's data uses on disk",
    group: "machine",
    nounDefault: true,
    output: "storage.usage",
    seeAlso: ["storage clean", "storage compact"],
  },
  {
    id: "storage.plan",
    words: ["storage", "plan"],
    summary: "Plan a cleanup to review, without removing anything",
    group: "machine",
    flags: planFlags,
    output: "storage.plan",
    examples: [
      { command: "ace storage plan --logs --older-than 14d", summary: "Logs older than two weeks" },
      { command: "ace storage plan --retention @keep.json", summary: "Your own retention" },
    ],
  },
  {
    id: "storage.clean",
    words: ["storage", "clean"],
    summary: "Plan a cleanup, show it, ask, then apply it",
    description:
      "On a terminal it asks before removing anything. Anywhere else it needs --yes, or --dry-run to only show the plan.",
    group: "machine",
    mutates: true,
    flags: [...planFlags, { name: "dry-run", summary: "Show the plan; change nothing" }],
    aliases: [{ words: ["clean"], deprecatedSince: since, byFlag: { compact: "storage.compact" } }],
    output: "storage.clean",
    examples: [
      { command: "ace storage clean --logs --older-than 30d", summary: "Old logs" },
      { command: "ace storage clean --threads --dry-run", summary: "See what would go" },
      { command: "ace storage clean --caches --yes", summary: "From a script" },
    ],
    exits: [{ code: 4, when: "no --yes off a terminal, or the person said no" }],
  },
  {
    id: "storage.apply",
    words: ["storage", "apply"],
    summary: "Apply a reviewed cleanup plan",
    group: "machine",
    mutates: true,
    args: [planArg],
    flags: [{ name: "revision", value: "REVISION", summary: "The plan revision you reviewed" }],
    aliases: [{ words: ["clean", "apply"], deprecatedSince: since }],
    output: "storage.receipt",
    exits: [{ code: 4, when: "the plan changed since it was reviewed; nothing was removed" }],
  },
  {
    id: "storage.status",
    words: ["storage", "status"],
    summary: "Where a cleanup plan stands",
    group: "machine",
    args: [planArg],
    aliases: [{ words: ["clean", "status"], deprecatedSince: since }],
    output: "storage.receipt",
  },
  {
    id: "storage.compact",
    words: ["storage", "compact"],
    summary: "Give the database's free space back to the disk",
    group: "machine",
    mutates: true,
    flags: [
      { name: "abandon", value: "ID", summary: "Give up a compaction that's stuck" },
      { name: "compact", summary: "The old ace clean --compact", hidden: true },
    ],
    output: "storage.compact",
  },
];

const keyArg = {
  name: "KEY",
  summary: "A setting, like threads.useWorktree (ace config list shows them all)",
  required: true,
};

export const configCommands: readonly CommandSpec[] = [
  {
    id: "config.list",
    words: ["config", "list"],
    summary: "Every setting and its value",
    group: "machine",
    offline: true,
    nounDefault: true,
    output: "config.list",
  },
  {
    id: "config.get",
    words: ["config", "get"],
    summary: "One setting: its value, what it does and what it takes",
    group: "machine",
    offline: true,
    // Bare `ace config get` is the first CLI's way to list them all.
    args: [{ ...keyArg, required: false }],
    output: "config.entry",
  },
  {
    id: "config.set",
    personOnly: "setting",
    words: ["config", "set"],
    summary: "Change a setting",
    group: "machine",
    offline: true,
    mutates: true,
    args: [
      keyArg,
      { name: "VALUE", summary: "Its new value; @FILE for a JSON one", required: true },
    ],
    output: "config.entry",
    examples: [
      {
        command: "ace config set threads.useWorktree off",
        summary: "Threads start in the project",
      },
      { command: "ace config set providers.default claude", summary: "New threads use Claude" },
      { command: "ace config set retention-days 60", summary: "Keep idle data for 60 days" },
    ],
  },
  {
    id: "config.unset",
    personOnly: "setting",
    words: ["config", "unset"],
    summary: "Put a setting back to its default",
    group: "machine",
    offline: true,
    mutates: true,
    args: [keyArg],
    output: "config.entry",
  },
];
