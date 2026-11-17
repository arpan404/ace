import { grammarRelease as since, idempotencyKey } from "./flags.ts";
import type { CommandSpec, NounSpec } from "./spec.ts";

/** Spade, Beta switches and automations (ADR 0176 §7). */
export const spadeNouns: readonly NounSpec[] = [
  { name: "spade", summary: "Spade, ace's assistant", group: "spade-market" },
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
export const spadeCommands: readonly CommandSpec[] = [
  {
    id: "spade.on",
    words: ["spade", "on"],
    summary: "Turn Spade on",
    group: "spade-market",
    offline: true,
    mutates: true,
  },
  {
    id: "spade.off",
    words: ["spade", "off"],
    summary: "Turn Spade off",
    group: "spade-market",
    offline: true,
    mutates: true,
  },
  {
    id: "feature.list",
    words: ["feature", "list"],
    summary: "Beta features and whether each is on",
    group: "spade-market",
    offline: true,
    nounDefault: true,
    aliases: [{ words: ["features"], quiet: true }],
  },
  {
    id: "feature.on",
    words: ["feature", "on"],
    summary: "Turn a Beta feature on",
    group: "spade-market",
    offline: true,
    mutates: true,
    args: [featureArg],
    aliases: [{ words: ["features", "on"], deprecatedSince: since }],
  },
  {
    id: "feature.off",
    words: ["feature", "off"],
    summary: "Turn a Beta feature off",
    group: "spade-market",
    offline: true,
    mutates: true,
    args: [featureArg],
    aliases: [{ words: ["features", "off"], deprecatedSince: since }],
  },
  {
    id: "automation.list",
    words: ["automation", "list"],
    summary: "Your automations",
    group: "spade-market",
    nounDefault: true,
    aliases: [{ words: ["automations"], quiet: true }],
  },
  {
    id: "automation.run",
    words: ["automation", "run"],
    summary: "Run an automation now",
    group: "spade-market",
    mutates: true,
    args: [{ name: "AUTOMATION", summary: "The automation id", required: true }],
    flags: [
      { name: "variables", value: "@FILE", summary: "Its variables, from a JSON file" },
      idempotencyKey,
    ],
  },
];
