import { grammarRelease as since, idempotencyKey, limit, outputPath, threadRef } from "./flags.ts";
import type { ArgSpec, CommandSpec, FlagSpec, NounSpec } from "./spec.ts";

/** Tools agents call from a shell (ADR 0176 §7, Agent tools). */
export const agentToolNouns: readonly NounSpec[] = [
  {
    name: "browser",
    summary: "A thread's browser: screenshots and recordings",
    group: "agent-tools",
  },
  {
    name: "sim",
    summary: "iOS simulators and Android emulators, as a thread's agent",
    group: "agent-tools",
  },
  { name: "cloud", summary: "Codex Cloud through the installed Codex CLI", group: "agent-tools" },
];

const browserFlags: readonly FlagSpec[] = [
  { name: "url", value: "URL", summary: "Open this page first" },
  outputPath,
  { name: "duration", value: "DURATION", summary: "How long to record, e.g. 5s" },
];
const browserThread = { name: "THREAD", summary: "The thread whose browser", required: true };
const simArg = { name: "SIM", summary: "The simulator or emulator", required: true } as const;
const simFlags: readonly FlagSpec[] = [
  threadRef,
  { name: "human", summary: "Short text (now the default)", hidden: true },
];
const sim = (
  verb: string,
  summary: string,
  extra: readonly FlagSpec[] = [],
  args: readonly ArgSpec[] = [simArg],
): CommandSpec => ({
  id: `sim.${verb}`,
  words: ["sim", verb],
  summary,
  group: "agent-tools",
  mutates: !["list", "ui", "logs", "screenshot"].includes(verb),
  args,
  flags: [...simFlags, ...extra],
  ...(verb === "list" ? { nounDefault: true } : {}),
});
const cloudFlags: readonly FlagSpec[] = [
  { name: "env", value: "ENV_ID", summary: "The Codex Cloud environment" },
  { name: "attempts", value: "N", summary: "Attempts, 1 to 4" },
  { name: "branch", value: "BRANCH", summary: "The branch to start from" },
  limit,
  { name: "cursor", value: "CURSOR", summary: "The page after this cursor" },
  { name: "attempt", value: "N", summary: "Which attempt" },
  idempotencyKey,
];
const cloud = (verb: string, summary: string, args: readonly ArgSpec[]): CommandSpec => ({
  id: `cloud.codex.${verb}`,
  words: ["cloud", "codex", verb],
  summary,
  group: "agent-tools",
  offline: true,
  mutates: verb === "exec" || verb === "apply",
  args,
  flags: cloudFlags,
});
const task = [{ name: "TASK", summary: "The Codex Cloud task id", required: true }] as const;

export const agentToolCommands: readonly CommandSpec[] = [
  {
    id: "browser.screenshot",
    words: ["browser", "screenshot"],
    summary: "A screenshot of a thread's browser, saved to a file",
    group: "agent-tools",
    args: [browserThread],
    flags: browserFlags,
    aliases: [{ words: ["browser", "shot"], deprecatedSince: since }],
  },
  {
    id: "browser.record",
    words: ["browser", "record"],
    summary: "An MP4 of a thread's browser, saved to a file",
    group: "agent-tools",
    args: [browserThread],
    flags: browserFlags,
  },
  sim("list", "Simulators and emulators on this machine", [], []),
  sim("start", "Take a simulator for the thread, boot it and show it live", [
    { name: "no-boot", summary: "Don't boot it" },
  ]),
  sim("stop", "Release a simulator when you finish"),
  sim(
    "ui",
    "Read the screen; actionable elements carry refs like @e3",
    [
      { name: "text", value: "TEXT", summary: "Only elements with this text" },
      { name: "role", value: "ROLE", summary: "Only elements with this role" },
      limit,
      { name: "max-depth", value: "N", summary: "How deep to read" },
      { name: "max-nodes", value: "N", summary: "How many elements to read" },
    ],
    [simArg, { name: "NAME", summary: "Only elements named this" }],
  ),
  sim(
    "act",
    "Tap, type, swipe, press keys or open apps (ace help sim act)",
    [
      { name: "value", value: "VALUE", summary: "The value for setValue" },
      { name: "duration", value: "MS", summary: "How long to press or swipe" },
      { name: "name", value: "NAME", summary: "An element name", hidden: true },
    ],
    [
      simArg,
      { name: "ACTION", summary: "What to do, then its arguments", required: true, variadic: true },
    ],
  ),
  sim("screenshot", "A JPEG of the screen", [
    outputPath,
    { name: "out", value: "FILE", summary: "Same as --output", hidden: true },
  ]),
  sim("logs", "The device's recent log", [limit]),
  cloud("exec", "Start a Codex Cloud task", [
    { name: "PROMPT", summary: "What to do; - reads stdin", stdin: true },
  ]),
  cloud("list", "Codex Cloud tasks", []),
  cloud("status", "A Codex Cloud task's state", task),
  cloud("diff", "A Codex Cloud task's diff", task),
  cloud("apply", "Apply a Codex Cloud task's diff here", task),
];
