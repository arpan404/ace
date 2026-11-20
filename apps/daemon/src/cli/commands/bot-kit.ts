import type { CommandSpec } from "./spec.ts";

/*
 * The developer kit for agent packages (ADR 0200 §9), in ADR 0178's grammar: make a package,
 * check it as the market and Spade read it, try it on a development Spade, test it offline,
 * publish it free.
 */

const pathArg = {
  name: "PATH",
  summary: "The package's folder; this one when omitted",
} as const;

export const botKitCommands: readonly CommandSpec[] = [
  {
    id: "bot.init",
    words: ["bot", "init"],
    summary: "Make a package folder: bot.json, a skill, a card, a scenario test and a README",
    description:
      "Every file is valid as written: the folder passes ace bot check and ace bot test before you change a word. Templates: blank (it answers when you write to it), watcher (a schedule, a network effect and a card), club-member (answers when mentioned in a thread or club).",
    group: "spade-market",
    offline: true,
    mutates: true,
    args: [{ name: "NAME", summary: 'The bot\'s name, like "Fare watcher"', required: true }],
    flags: [
      {
        name: "template",
        value: "T",
        summary: "What it starts as: blank, watcher or club-member",
        choices: ["blank", "watcher", "club-member"],
      },
      { name: "path", value: "PATH", summary: "Where to make it; ./<name> otherwise" },
    ],
    output: "bot.init",
    examples: [
      {
        command: 'ace bot init "Fare watcher" --template watcher',
        summary: "A bot that checks on a schedule and shows a card",
      },
    ],
    exits: [{ code: 4, when: "the folder already holds files" }],
    seeAlso: ["bot check", "bot test"],
  },
  {
    id: "bot.check",
    words: ["bot", "check"],
    summary: "The market's checks on a package, with every problem at its place; no account",
    description:
      "The same reader Spade and the market use. Problems print as path: sentence and exit 1. Warnings (a thin why on an effect, no scenario tests) don't fail the check.",
    group: "spade-market",
    offline: true,
    args: [pathArg],
    output: "bot.check",
    exits: [{ code: 1, when: "the package has a problem to fix" }],
    seeAlso: ["bot test", "market check"],
  },
  {
    id: "bot.test",
    words: ["bot", "test"],
    summary: "Run the package's scenario tests on Spade's engine with a scripted model, offline",
    description:
      "Each scenario in tests/ runs on a throwaway Spade with spade-testkit's fake model: no network, no real model, nothing of yours. Needs Spade's program: the one this ace ships, or ACE_SPADE_BIN.",
    group: "spade-market",
    offline: true,
    args: [pathArg],
    output: "bot.test",
    exits: [{ code: 1, when: "a scenario failed, or the package or a scenario didn't read" }],
    seeAlso: ["bot check"],
  },
  {
    id: "bot.dev",
    personOnly: "install",
    words: ["bot", "dev"],
    summary: "Install the package here as a development bot, and update it on every save",
    description:
      "It installs once as local/<folder>, linked to the folder, its routines paused. Each save is checked and applied as an update at the bot's next quiet moment. A save that asks for more (an effect, a trigger kind, an app) asks you again. Ctrl-C to stop watching; the bot stays.",
    group: "spade-market",
    mutates: true,
    args: [pathArg],
    flags: [
      {
        name: "spade",
        value: "DIR",
        summary: "A development Spade's data folder, reached directly instead of through ace",
      },
      { name: "once", summary: "Install or update once, then stop" },
    ],
    output: "bot.dev",
    exits: [
      { code: 1, when: "the package has a problem to fix" },
      { code: 2, when: "it asks for more and needs your yes" },
    ],
    seeAlso: ["bot running", "bot check"],
  },
  {
    id: "bot.publish",
    words: ["bot", "publish"],
    summary: "Check and test the package, then publish it free: ace market publish spade-bot PATH",
    group: "spade-market",
    mutates: true,
    args: [pathArg],
    flags: [
      { name: "version", value: "VERSION", summary: "The version to publish, such as 1.0.0" },
      { name: "name", value: "NAME", summary: "The entry's name; the folder's otherwise" },
      { name: "changelog", value: "TEXT|-|@FILE", summary: "What changed in this version" },
      { name: "draft", summary: "Stop at the draft and print its id" },
      { name: "unlisted", summary: "Reached by its link, not by search" },
      { name: "wait", summary: "Watch until it is live or blocked" },
    ],
    output: "bot.publish",
    exits: [
      { code: 1, when: "a check or a scenario failed, or the market's scan blocked it" },
      { code: 2, when: "signed out, or it needs your yes" },
    ],
    seeAlso: ["market publish", "market status"],
  },
];
