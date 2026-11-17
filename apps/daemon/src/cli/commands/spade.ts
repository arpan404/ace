import { grammarRelease as since, idempotencyKey } from "./flags.ts";
import type { CommandSpec, NounSpec } from "./spec.ts";

/** Spade, Beta switches and automations (ADR 0176 §7). */
export const spadeNouns: readonly NounSpec[] = [
  { name: "spade", summary: "Spade, ace's assistant, and its bots", group: "spade-market" },
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
const botArg = { name: "BOT", summary: "A bot's id or name", required: true } as const;
const automationArg = { name: "AUTOMATION", summary: "The automation id", required: true } as const;

export const spadeCommands: readonly CommandSpec[] = [
  {
    id: "spade.status",
    words: ["spade", "status"],
    summary: "Whether Spade is on, and how it is",
    group: "spade-market",
    offline: true,
    nounDefault: true,
    output: "spade.status",
  },
  {
    id: "spade.on",
    personOnly: "setting",
    words: ["spade", "on"],
    summary: "Turn Spade on",
    description:
      "While Settings › Beta hides Spade, this turns that on too: it asks once on a terminal, and needs --yes anywhere else.",
    group: "spade-market",
    offline: true,
    mutates: true,
    output: "spade.switch",
    exits: [{ code: 4, when: "Beta hides Spade and there's no terminal to ask, nor --yes" }],
  },
  {
    id: "spade.off",
    personOnly: "setting",
    words: ["spade", "off"],
    summary: "Turn Spade off; its data is kept",
    group: "spade-market",
    offline: true,
    mutates: true,
    output: "spade.switch",
  },
  {
    id: "spade.bot.list",
    words: ["spade", "bot", "list"],
    summary: "Spade's bots, and what each is doing",
    group: "spade-market",
    nounDefault: true,
    output: "spade.bot.list",
    aliases: [{ words: ["spade", "bots"], quiet: true }],
  },
  {
    id: "spade.bot.show",
    words: ["spade", "bot", "show"],
    summary: "One bot: its task, model and latest message",
    group: "spade-market",
    args: [botArg],
    output: "spade.bot.show",
  },
  {
    id: "spade.chat",
    words: ["spade", "chat"],
    summary: "Talk with a bot (Spade's main bot by default)",
    description:
      "With TEXT it sends one message and prints the reply. Without it, on a terminal, it is a conversation: type a line, read the answer, Ctrl-C to leave.",
    group: "spade-market",
    mutates: true,
    args: [
      { name: "BOT", summary: "A bot's id or name; Spade's main bot when omitted" },
      { name: "TEXT", summary: "One message to send; - reads it from stdin", stdin: true },
    ],
    output: "spade.chat",
    exits: [
      { code: 2, when: "the bot is waiting on you for an approval or a question" },
      { code: 3, when: "no reply came within --timeout (it may still answer)" },
    ],
    examples: [
      { command: "ace spade chat", summary: "A conversation with Spade" },
      { command: 'ace spade chat writer "Draft the release notes"', summary: "One message" },
    ],
  },
  {
    id: "feature.list",
    words: ["feature", "list"],
    summary: "Beta features and whether each is on",
    group: "spade-market",
    offline: true,
    nounDefault: true,
    aliases: [{ words: ["features"], quiet: true }],
    output: "feature.list",
  },
  {
    id: "feature.on",
    personOnly: "setting",
    words: ["feature", "on"],
    summary: "Turn a Beta feature on",
    group: "spade-market",
    offline: true,
    mutates: true,
    args: [featureArg],
    aliases: [{ words: ["features", "on"], deprecatedSince: since }],
    output: "feature.switch",
  },
  {
    id: "feature.off",
    personOnly: "setting",
    words: ["feature", "off"],
    summary: "Turn a Beta feature off",
    group: "spade-market",
    offline: true,
    mutates: true,
    args: [featureArg],
    aliases: [{ words: ["features", "off"], deprecatedSince: since }],
    output: "feature.switch",
  },
  {
    id: "automation.list",
    words: ["automation", "list"],
    summary: "Your automations",
    group: "spade-market",
    nounDefault: true,
    aliases: [{ words: ["automations"], quiet: true }],
    output: "automation.list",
  },
  {
    id: "automation.show",
    words: ["automation", "show"],
    summary: "One automation: its trigger, next run and last run",
    group: "spade-market",
    args: [automationArg],
    output: "automation.show",
  },
  {
    id: "automation.run",
    words: ["automation", "run"],
    summary: "Run an automation now",
    group: "spade-market",
    mutates: true,
    args: [automationArg],
    flags: [
      { name: "variables", value: "@FILE", summary: "Its variables, from a JSON file" },
      { name: "message", value: "TEXT", summary: "Extra instructions for this run only" },
      idempotencyKey,
    ],
    output: "automation.receipt",
    examples: [
      { command: "ace automation run nightly", summary: "Now" },
      { command: "ace automation run release --variables @vars.json", summary: "With variables" },
    ],
  },
  {
    id: "automation.create",
    words: ["automation", "create"],
    summary: "Save an automation from a JSON definition",
    group: "spade-market",
    mutates: true,
    args: [
      {
        name: "DEFINITION",
        summary: "@FILE: the automation as JSON (ace automation show ID --json shows one)",
        required: true,
      },
    ],
    flags: [idempotencyKey],
    output: "automation.receipt",
  },
  {
    id: "automation.remove",
    words: ["automation", "remove"],
    summary: "Delete an automation",
    group: "spade-market",
    mutates: true,
    args: [automationArg],
    flags: [idempotencyKey],
    output: "automation.receipt",
  },
];
