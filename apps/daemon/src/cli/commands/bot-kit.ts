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

const againstFlag = {
  name: "against",
  value: "PATH",
  summary:
    "The version other bots call (its folder or bot.json): a contract change that breaks them is refused",
} as const;

export const botKitCommands: readonly CommandSpec[] = [
  {
    id: "bot.init",
    words: ["bot", "init"],
    summary: "Make a package folder: bot.json, a skill, a card, a scenario test and a README",
    description:
      "Every file is valid as written: the folder passes ace bot check and ace bot test before you change a word. Templates: blank (it answers when you write to it), watcher (a schedule, a network effect and a card), club-member (answers when mentioned in a thread or club). With --from, one of your own bots becomes the package: its task, face, personality, routines as triggers, the skills and apps it uses, and each effect its calls had, declared with a TODO where you say why. Its conversation, notes, knowledge, workspace files, keys and grants stay with the bot.",
    group: "spade-market",
    offline: true,
    mutates: true,
    args: [
      {
        name: "NAME",
        summary:
          "The bot's name, like \"Fare watcher\"; with --from, the bot's own name when omitted",
      },
    ],
    flags: [
      {
        name: "template",
        value: "T",
        summary: "What it starts as: blank, watcher or club-member",
        choices: ["blank", "watcher", "club-member"],
      },
      { name: "from", value: "BOT", summary: "One of your bots, by name or id, to start from" },
      {
        name: "spade",
        value: "DIR",
        summary:
          "With --from: a development Spade's data folder, reached directly instead of through ace",
      },
      { name: "path", value: "PATH", summary: "Where to make it; ./<name> otherwise" },
    ],
    output: "bot.init",
    examples: [
      {
        command: 'ace bot init "Fare watcher" --template watcher',
        summary: "A bot that checks on a schedule and shows a card",
      },
      {
        command: 'ace bot init --from "Release notes"',
        summary: "Your bot Release notes as a package folder to finish and publish",
      },
    ],
    exits: [{ code: 4, when: "the folder already holds files" }],
    seeAlso: ["bot check", "bot test", "bot dev"],
  },
  {
    id: "bot.check",
    words: ["bot", "check"],
    summary: "The market's checks on a package, with every problem at its place; no account",
    description:
      "The same reader Spade and the market use. Problems print as path: sentence and exit 1. Warnings (a thin why on an effect, a TODO left to write, no scenario tests) don't fail the check. With --against, the version other bots call is compared too: a change to a contract that would break them (a field gone or newly required, less text taken, an output that may hold what callers never saw) is refused, since a breaking change takes a new name.",
    group: "spade-market",
    offline: true,
    args: [pathArg],
    flags: [againstFlag],
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
      "It installs once, linked to the local package of its name (local/<name>), its routines paused, and shows Development in your list. Each save is checked and applied as an update at the bot's next quiet moment. A save that asks for more (an effect, a trigger kind, an app) asks you again. The bot belongs to the folder: renaming it in bot.json renames the same bot, and another folder makes another bot. Ctrl-C to stop watching; the bot stays.",
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
    description:
      "Before uploading it reads the latest version published in the market (ACE_MARKET_URL for a development one) and refuses a change to a contract that would break the bots calling it; a breaking change takes a new name. The market's signer refuses the same change.",
    group: "spade-market",
    mutates: true,
    args: [pathArg],
    flags: [
      { name: "version", value: "VERSION", summary: "The version to publish, such as 1.0.0" },
      againstFlag,
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
