import { follow, grammarRelease as since, limit, providerName } from "./flags.ts";
import type { CommandSpec, FlagSpec, NounSpec } from "./spec.ts";

/** The daemon, its service, storage, settings and repair (ADR 0176 §7, This machine). */
export const machineNouns: readonly NounSpec[] = [
  { name: "daemon", summary: "The ace daemon on this machine", group: "machine" },
  { name: "service", summary: "Run ace at login", group: "machine" },
  { name: "storage", summary: "What ace's data uses on disk, and cleaning it", group: "machine" },
  { name: "config", summary: "Settings", group: "machine" },
  { name: "doctor", summary: "Check ace and repair what's broken", group: "machine" },
];

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
  { name: "older-than", value: "DURATION", summary: "Only what's older than this, e.g. 30d" },
  { name: "kinds", value: "KIND,…", summary: "Kinds as one list", hidden: true },
  { name: "retention", value: "JSON", summary: "Retention as JSON", hidden: true },
  { name: "force-items", value: "JSON", summary: "Protected items as JSON", hidden: true },
];
const planArg = { name: "PLAN", summary: "The plan id", required: true } as const;

const serviceSummaries = {
  install: "Run ace at login (launchd, systemd or Task Scheduler)",
  uninstall: "Stop running ace at login",
  start: "Start the login service",
  stop: "Stop the login service",
  status: "Whether ace runs at login",
} as const;

function serviceCommand(verb: keyof typeof serviceSummaries): CommandSpec {
  const base: CommandSpec = {
    id: `service.${verb}`,
    words: ["service", verb],
    summary: serviceSummaries[verb],
    group: "machine",
    offline: true,
    mutates: verb !== "status",
    nounDefault: verb === "status",
  };
  return verb === "install"
    ? { ...base, flags: [{ name: "linger", summary: "Keep running after logout (Linux)" }] }
    : base;
}

export const machineCommands: readonly CommandSpec[] = [
  {
    id: "daemon.start",
    words: ["daemon", "start"],
    summary: "Run the daemon in this terminal",
    description:
      "The desktop app and the login service run this. It stays in the foreground until stopped.",
    group: "machine",
    aliases: [{ words: ["start"] }],
    exits: [
      { code: 6, when: "the port is taken" },
      { code: 7, when: "another daemon holds this ace home" },
      { code: 65, when: "a newer ace wrote this home" },
      { code: 66, when: "a store is in a format this build doesn't read" },
    ],
    output: "daemon.start",
  },
  {
    id: "daemon.serve",
    words: ["daemon", "serve"],
    summary: "Run the daemon with a headless browser",
    group: "machine",
    aliases: [{ words: ["serve"] }],
    output: "daemon.start",
  },
  {
    id: "daemon.stop",
    words: ["daemon", "stop"],
    summary: "Stop the daemon and wait for its cleanup",
    group: "machine",
    mutates: true,
    aliases: [{ words: ["stop"] }],
    output: "daemon.stop",
  },
  {
    id: "daemon.status",
    words: ["daemon", "status"],
    summary: "The daemon's health",
    group: "machine",
    nounDefault: true,
    output: "daemon.status",
  },
  {
    id: "daemon.logs",
    words: ["daemon", "logs"],
    summary: "The daemon's recent log",
    group: "machine",
    offline: true,
    flags: [follow, limit, { name: "f", summary: "Same as --follow", hidden: true }],
    aliases: [{ words: ["logs"] }],
  },
  {
    id: "daemon.token",
    words: ["daemon", "token"],
    summary: "This machine's host token",
    group: "machine",
    offline: true,
    aliases: [{ words: ["token"], deprecatedSince: since }],
  },
  ...(["install", "uninstall", "start", "stop", "status"] as const).map(serviceCommand),
  {
    id: "storage.usage",
    words: ["storage", "usage"],
    summary: "What ace's data uses on disk",
    group: "machine",
    nounDefault: true,
    output: "storage.usage",
  },
  {
    id: "storage.plan",
    words: ["storage", "plan"],
    summary: "Plan a cleanup to review",
    group: "machine",
    flags: planFlags,
    output: "storage.plan",
  },
  {
    id: "storage.clean",
    words: ["storage", "clean"],
    summary: "Plan a cleanup, show it, ask, then apply it",
    group: "machine",
    mutates: true,
    flags: [...planFlags, { name: "dry-run", summary: "Show the plan; change nothing" }],
    aliases: [
      {
        words: ["clean"],
        deprecatedSince: since,
        byFlag: { compact: "storage.compact" },
      },
    ],
    examples: [
      { command: "ace storage clean --logs --older-than 30d", summary: "Old logs" },
      { command: "ace storage clean --threads --dry-run", summary: "See what would go" },
    ],
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
  },
  {
    id: "storage.status",
    words: ["storage", "status"],
    summary: "Where a cleanup plan stands",
    group: "machine",
    args: [planArg],
    aliases: [{ words: ["clean", "status"], deprecatedSince: since }],
  },
  {
    id: "storage.compact",
    words: ["storage", "compact"],
    summary: "Compact ace's database",
    group: "machine",
    mutates: true,
    flags: [
      { name: "abandon", value: "ID", summary: "Give up a compaction that's stuck" },
      { name: "compact", summary: "The old ace clean --compact", hidden: true },
    ],
  },
  {
    id: "config.get",
    words: ["config", "get"],
    summary: "A setting's value, or every setting",
    group: "machine",
    offline: true,
    nounDefault: true,
    args: [{ name: "KEY", summary: "The setting; every one when omitted" }],
  },
  {
    id: "config.set",
    words: ["config", "set"],
    summary: "Change a setting",
    group: "machine",
    offline: true,
    mutates: true,
    args: [
      { name: "KEY", summary: "The setting", required: true },
      { name: "VALUE", summary: "Its new value", required: true },
    ],
  },
  {
    id: "doctor",
    words: ["doctor"],
    summary: "Check ace, then repair what's broken",
    group: "machine",
    offline: true,
    flags: [
      { name: "fix", summary: "Apply the recommended repairs" },
      { name: "dry-run", summary: "Plan repairs without running them" },
      { name: "all", summary: "Run every check, not only the quick ones" },
      providerName,
    ],
  },
  {
    id: "doctor.bundle",
    words: ["doctor", "bundle"],
    summary: "Write a redacted support bundle",
    group: "machine",
    offline: true,
    args: [{ name: "PATH", summary: "Where to write it", required: true }],
    flags: [{ name: "include-threads", summary: "Include thread transcripts" }],
    aliases: [{ words: ["support-bundle"], deprecatedSince: since }],
  },
  {
    id: "triage",
    words: ["triage"],
    summary: "Hand what's broken to an agent, with the facts it needs",
    group: "machine",
    offline: true,
    flags: [providerName, { name: "print", summary: "Print the playbook instead of starting" }],
  },
  ...(["update", "supervise", "migrate-check", "spade-follow", "install-artifact"] as const).map(
    (word): CommandSpec => ({
      id: `release.${word}`,
      words: [word],
      summary: "Part of an installed release; the release runtime runs it before the CLI",
      group: "machine",
      hidden: true,
      offline: true,
      passthrough: true,
      args: [{ name: "ARGS", summary: "Passed through", variadic: true }],
    }),
  ),
];
