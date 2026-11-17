import type { CommandSpec } from "./spec.ts";

/** Help, version, completions, the machine overview and the interactive home. */
export const basicCommands: readonly CommandSpec[] = [
  {
    id: "home",
    words: [],
    summary: "The interactive home on a terminal; this overview otherwise",
    group: "basics",
    offline: true,
    hidden: true,
  },
  {
    id: "help",
    words: ["help"],
    summary: "Help for a command or a topic",
    group: "basics",
    offline: true,
    args: [{ name: "COMMAND", summary: "A command or topic", variadic: true }],
    flags: [{ name: "schema", summary: "The command's --json output as JSON Schema" }],
    examples: [
      { command: "ace help thread", summary: "Everything you can do to a thread" },
      { command: "ace help --json", summary: "Every command, flag and exit code as JSON" },
      { command: "ace help agents", summary: "How agents should call ace" },
    ],
    output: "help",
  },
  {
    id: "version",
    words: ["version"],
    summary: "The CLI's version",
    group: "basics",
    offline: true,
    output: "version",
  },
  {
    id: "completion",
    words: ["completion"],
    summary: "Tab completion for bash, zsh, fish or PowerShell",
    group: "basics",
    offline: true,
    args: [{ name: "SHELL", summary: "bash, zsh, fish, powershell, or install", required: true }],
    examples: [
      { command: "ace completion install", summary: "Install it for your shell" },
      { command: 'eval "$(ace completion bash)"', summary: "Try it in this bash" },
    ],
  },
  {
    id: "complete",
    words: ["__complete"],
    summary: "Completion candidates for the words typed so far",
    group: "basics",
    offline: true,
    hidden: true,
    passthrough: true,
    args: [{ name: "WORDS", summary: "The words typed so far", variadic: true }],
  },
  {
    id: "status",
    words: ["status"],
    summary: "This machine: the daemon, your account, what needs you, what runs",
    group: "basics",
    offline: true,
    output: "status",
  },
];
