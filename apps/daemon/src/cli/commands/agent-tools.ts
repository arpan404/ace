import { grammarRelease as since, idempotencyKey, limit, outputPath, threadRef } from "./flags.ts";
import type { ArgSpec, CommandSpec, FlagSpec, NounSpec } from "./spec.ts";

/** Tools agents call from a shell (ADR 0178 §7, Agent tools). */
export const agentToolNouns: readonly NounSpec[] = [
  {
    name: "browser",
    summary: "A thread's browser: screenshots and recordings",
    group: "agent-tools",
  },
  {
    name: "sim",
    summary: "iOS simulators and Android emulators, as a thread's agent",
    description: simGuide(),
    group: "agent-tools",
  },
  { name: "cloud", summary: "Codex Cloud through the installed Codex CLI", group: "agent-tools" },
];

const browserFlags: readonly FlagSpec[] = [
  { name: "url", value: "URL", summary: "Open this page first" },
  outputPath,
  { name: "duration", value: "DURATION", summary: "How long to record, e.g. 5s" },
];
// Optional in the table: an agent's shell has ACE_THREAD_ID, and the handler names what's missing.
const browserThread = {
  name: "THREAD",
  summary: "The thread whose browser; defaults to ACE_THREAD_ID in an agent's shell",
  ref: "thread",
} as const;
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
  description?: string,
): CommandSpec => ({
  id: `sim.${verb}`,
  words: ["sim", verb],
  summary,
  ...(description ? { description } : {}),
  group: "agent-tools",
  mutates: !["list", "ui", "logs", "screenshot"].includes(verb),
  args,
  flags: [...simFlags, ...extra],
  examples: simExamples[verb] ?? [],
  output: "agent-tool",
  exits: [{ code: 2, when: "A person holds the device (lease_required)" }],
  ...(verb === "list" ? { nounDefault: true } : {}),
});
const simExamples: Readonly<Record<string, readonly { command: string; summary: string }[]>> = {
  list: [{ command: "ace sim list", summary: "Devices, from an agent's shell" }],
  start: [{ command: "ace sim start ios-17", summary: "Take and boot a simulator" }],
  stop: [{ command: "ace sim stop ios-17", summary: "Release it" }],
  ui: [{ command: "ace sim ui ios-17 --text Login", summary: "Find the login button's ref" }],
  act: [
    { command: "ace sim act ios-17 tap @e3", summary: "Tap an element by its ref" },
    { command: "ace sim act ios-17 type @e5 hello", summary: "Type into a field" },
  ],
  screenshot: [
    { command: "ace sim screenshot ios-17 --output shot.jpg", summary: "Save the screen" },
  ],
  logs: [{ command: "ace sim logs ios-17 --limit 50", summary: "The last 50 log lines" }],
};
/** `ace help sim act`: every action, as the sim_act tool takes them. */
const actDescription = [
  "Refs first: ace sim ui, act on a ref, ui again after the screen changes. Coordinates are the fallback. A ref is re-checked before acting: stale_ref if it has gone.",
  "",
  "  tap @e3 | tap X Y                       tap an element, or a point",
  "  type @e3 TEXT                           focus the element, then type (no ref: the focused field)",
  "  press|focus|setValue|scroll|select|expand @e3 [--value V]",
  "  long_press @e3|X Y [--duration MS]",
  "  swipe X Y TOX TOY [--duration MS]",
  "  key home|back|enter|rotate|power|recents|volumeUp|volumeDown|action|side",
  "  open_app ID | open_url URL | install PATH | record_start | record_stop",
  "  clipboard_get | clipboard_set TEXT      read the clipboard, or set it without pasting",
  "  posture closed|partiallyOpen|open       fold or unfold a foldable device",
].join("\n");
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
  output: "agent-tool",
  examples: [
    { command: `ace cloud codex ${[verb, ...args.map((arg) => arg.name)].join(" ")}`, summary },
  ],
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
    examples: [
      {
        command: "ace browser screenshot --url http://localhost:5173 --output page.png",
        summary: "From an agent's shell",
      },
    ],
    output: "browser.artifact",
  },
  {
    id: "browser.record",
    words: ["browser", "record"],
    summary: "An MP4 of a thread's browser, saved to a file",
    group: "agent-tools",
    args: [browserThread],
    flags: browserFlags,
    examples: [{ command: "ace browser record --duration 10s", summary: "Ten seconds of it" }],
    output: "browser.artifact",
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
    actDescription,
  ),
  sim("screenshot", "A JPEG of the screen", [
    outputPath,
    { name: "out", value: "FILE", summary: "Same as --output", hidden: true },
  ]),
  sim("logs", "The device's recent log", [limit]),
  cloud("exec", "Start a Codex Cloud task", [
    { name: "PROMPT", summary: "What to do; - reads stdin", required: true, stdin: true },
  ]),
  cloud("list", "Codex Cloud tasks", []),
  cloud("status", "A Codex Cloud task's state", task),
  cloud("diff", "A Codex Cloud task's diff", task),
  cloud("apply", "Apply a Codex Cloud task's diff here", task),
];

/** `ace sim --help`: how an agent drives a device, refs first. */
function simGuide(): string {
  return `Drive iOS simulators and Android emulators as your thread's agent, from a shell: the same
operations, leases and element refs as the sim_* tools. Short text by default; --json for JSON.
--thread defaults to ACE_THREAD_ID, which ace sets in an agent's shell.

  ace sim list
  ace sim start SIM [--no-boot]        take SIM for the thread, boot it, start the live view
  ace sim ui SIM [NAME] [--text T] [--role R] [--limit N]
                                       read the screen; actionable elements carry refs like @e3
  ace sim act SIM tap @e3              act on a ref; it is re-checked first, stale_ref if it has gone
  ace sim act SIM type @e3 TEXT        focus the element, then type (without a ref: the focused field)
  ace sim screenshot SIM [--output FILE]  JPEG of the screen, with or without the live view
  ace sim logs SIM [--limit N]
  ace sim stop SIM                     release it when you finish

Refs first: ui, act on a ref, ui again after the screen changes. Coordinates are the fallback.
Every action: ace help sim act. Exit: 0 ok, 1 failed, 2 a person holds the device
(lease_required), 4 refused, 64 called wrong.`;
}
