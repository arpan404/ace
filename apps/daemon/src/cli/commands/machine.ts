import { follow, grammarRelease as since, limit } from "./flags.ts";
import { configCommands, storageCommands } from "./machine-storage.ts";
import type { CommandSpec, FlagSpec, NounSpec } from "./spec.ts";

/** The daemon, its service, storage, settings and repair (ADR 0176 §7, This machine). */
export const machineNouns: readonly NounSpec[] = [
  { name: "daemon", summary: "The ace daemon on this machine", group: "machine" },
  { name: "service", summary: "Run ace at login", group: "machine" },
  { name: "storage", summary: "What ace's data uses on disk, and cleaning it", group: "machine" },
  { name: "config", summary: "Settings", group: "machine" },
  { name: "doctor", summary: "Check ace and repair what's broken", group: "machine" },
];

/** Triage and doctor hand work to one of these agent CLIs (ADR 0092). */
const triageProvider: FlagSpec = {
  name: "provider",
  value: "PROVIDER",
  summary: "The agent to hand it to: claude, codex, cursor or opencode",
  choices: ["claude", "codex", "cursor", "opencode"],
};

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
    output: "service",
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
    description:
      "One line per record. With --follow it keeps printing; with --json it prints the records as JSON (one line each with --follow).",
    flags: [follow, limit, { name: "f", summary: "Same as --follow", hidden: true }],
    aliases: [{ words: ["logs"] }],
    output: "daemon.logs",
    examples: [
      { command: "ace logs --limit 20", summary: "The last 20 records" },
      { command: "ace logs --follow --json", summary: "Records as JSON Lines, as they come" },
    ],
  },
  {
    id: "daemon.token",
    words: ["daemon", "token"],
    summary: "This machine's host token",
    group: "machine",
    offline: true,
    aliases: [{ words: ["token"], deprecatedSince: since }],
    output: "daemon.token",
  },
  ...(["install", "uninstall", "start", "stop", "status"] as const).map(serviceCommand),
  ...storageCommands,
  ...configCommands,
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
      triageProvider,
    ],
    description:
      "Works with the daemon down. On a terminal it offers a checklist of repairs, and triage when findings remain.",
    output: "doctor",
    exits: [{ code: 1, when: "a check failed, or a repair did" }],
    seeAlso: ["triage", "doctor bundle"],
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
    output: "doctor.bundle",
  },
  {
    id: "triage",
    words: ["triage"],
    summary: "Hand what's broken to an agent, with the facts it needs",
    group: "machine",
    offline: true,
    description:
      "Writes what an agent needs to know about this machine to a folder, then starts the agent there. Works with ace broken.",
    flags: [triageProvider, { name: "print", summary: "Print the playbook instead of starting" }],
    output: "triage",
    seeAlso: ["doctor"],
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
