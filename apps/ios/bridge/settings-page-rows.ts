import type { SettingsKey } from "@ace/protocol";
import {
  accessLabel,
  accessModes,
  agentSettingTitles,
  atLimitLine,
  autoSettleChoices,
  childLimitChoices,
  childLimitNote,
  followUpChoices,
  limitPolicyChoices,
  sortByChoices,
  type LimitPolicyChoice,
} from "@ace/ui-core";

/*
 * The settings the phone edits on a machine, as data: which page and section each sits in, its
 * title and control, and the words for its choices. The web's titles and choices come from
 * `@ace/ui-core` (`agent-settings.ts`); rows the web words differently on its own pages keep the
 * phone's titles. Rows that need the machine's providers and models (default provider, roles,
 * utility model) are marked here and built in `settings-page-agents.ts`. Pure: no I/O.
 */

/** A choice as the phone draws it: `id` is what it sends back, `value` what is saved. */
export interface ChoiceSpec {
  id: string;
  label: string;
  value: unknown;
}

export type StaticControl =
  | { kind: "toggle" }
  | { kind: "choice"; style: "menu" | "segmented"; choices: (current: unknown) => ChoiceSpec[] }
  | { kind: "text"; placeholder: string }
  | { kind: "number" }
  | { kind: "list"; placeholder: string; add: string };

export interface StaticRow {
  kind: "static";
  key: SettingsKey;
  title: string;
  control: StaticControl;
  /** What the current value means, when that changes with it. */
  note?: (current: unknown) => string | null;
}
/** A row built from the machine's providers and models. */
export type AgentRow =
  | { kind: "defaultProvider" }
  | { kind: "role"; role: "build" | "judgment" | "review" | "verify" }
  | { kind: "utilityModel" };
export type RowSpec = StaticRow | AgentRow;

export interface SectionSpec {
  id: string;
  title: string | null;
  footer: string | null;
  rows: RowSpec[];
}
export interface PageSpec {
  id: string;
  title: string;
  sections: SectionSpec[];
}

/** A choice id for a saved value: strings as they are, anything else as JSON. */
export function choiceId(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}
function choices<T>(
  list: readonly { value: T; label: string }[],
): (current: unknown) => ChoiceSpec[] {
  return () =>
    list.map((entry) => ({ id: choiceId(entry.value), label: entry.label, value: entry.value }));
}
/** The phone's older rows name a raw value by itself, "read_only" as "Read Only". */
function named(values: readonly string[]): (current: unknown) => ChoiceSpec[] {
  return () => values.map((value) => ({ id: value, label: titleCase(value), value }));
}
function titleCase(value: string): string {
  return value
    .split(/[_-]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const toggle = (key: SettingsKey, title: string): StaticRow => ({
  kind: "static",
  key,
  title,
  control: { kind: "toggle" },
});
const menu = (
  key: SettingsKey,
  title: string,
  list: (current: unknown) => ChoiceSpec[],
  note?: StaticRow["note"],
): StaticRow => ({
  kind: "static",
  key,
  title,
  control: { kind: "choice", style: "menu", choices: list },
  ...(note ? { note } : {}),
});

const limitNote = (current: unknown) =>
  atLimitLine(
    limitPolicyChoices.some((choice) => choice.value === current)
      ? (current as LimitPolicyChoice)
      : undefined,
    undefined,
  );
const childCount = (current: unknown): number | null =>
  typeof current === "number" ? current : null;

const titles = agentSettingTitles;

/** Settings › Agents on one machine, in the web Agents page's sections. */
const agents: PageSpec = {
  id: "agents",
  title: "Agents",
  sections: [
    {
      id: "new",
      title: "New threads",
      footer: null,
      rows: [
        { kind: "defaultProvider" },
        menu(
          "access.defaultMode",
          titles["access.defaultMode"],
          choices(accessModes.map((mode) => ({ value: mode, label: accessLabel(mode) }))),
        ),
        toggle("threads.useWorktree", titles["threads.useWorktree"]),
        toggle("threads.forkOnSwitch", titles["threads.forkOnSwitch"]),
      ],
    },
    {
      id: "working",
      title: "While agents work",
      footer: null,
      rows: [
        {
          kind: "static",
          key: "threads.followUpBehavior",
          title: titles["threads.followUpBehavior"],
          control: { kind: "choice", style: "segmented", choices: choices(followUpChoices) },
        },
        menu(
          "threads.limitPolicy",
          titles["threads.limitPolicy"],
          choices(limitPolicyChoices),
          limitNote,
        ),
        menu(
          "agents.maxRunningChildren",
          titles["agents.maxRunningChildren"],
          (current) =>
            childLimitChoices(childCount(current)).map((choice) => ({
              id: choiceId(choice.value),
              label: choice.label,
              value: choice.value,
            })),
          (current) => childLimitNote(childCount(current)),
        ),
        menu(
          "threads.unresponsiveAfter",
          "Mark unresponsive after",
          choices([
            { value: "2m", label: "2 minutes" },
            { value: "5m", label: "5 minutes" },
            { value: "15m", label: "15 minutes" },
          ]),
        ),
      ],
    },
    {
      id: "roles",
      title: "Roles",
      footer: null,
      rows: [
        { kind: "role", role: "build" },
        { kind: "role", role: "judgment" },
        { kind: "role", role: "review" },
        { kind: "role", role: "verify" },
      ],
    },
    {
      id: "list",
      title: "Thread list",
      footer: null,
      rows: [
        menu("threads.sortBy", titles["threads.sortBy"], choices(sortByChoices)),
        menu(
          "threads.autoSettleAfter",
          titles["threads.autoSettleAfter"],
          choices(autoSettleChoices),
        ),
        toggle("threads.settleOnMerge", titles["threads.settleOnMerge"]),
        toggle("threads.settleOnClose", titles["threads.settleOnClose"]),
      ],
    },
    {
      id: "generation",
      title: "Generation",
      footer: null,
      rows: [
        { kind: "utilityModel" },
        toggle("generation.autoDraftCommits", "Draft commit messages automatically"),
      ],
    },
    {
      id: "automations",
      title: "Automations",
      footer: null,
      rows: [toggle("automations.enabled", titles["automations.enabled"])],
    },
  ],
};

const one = (
  id: string,
  title: string,
  rows: RowSpec[],
  footer: string | null = null,
): PageSpec => ({
  id,
  title,
  sections: [{ id, title: null, footer, rows }],
});
const savedHere = "Saved on this machine. A thread or project can override these defaults.";

/** Every page the phone shows for a machine, by id. */
export const settingsPages: Readonly<Record<string, PageSpec>> = {
  agents,
  remote: one(
    "remote",
    "Remote access",
    [
      {
        kind: "static",
        key: "host.displayName",
        title: "Machine name",
        control: { kind: "text", placeholder: "Machine name" },
      },
      toggle("remote.enabled", "Remote connections"),
      menu("remote.transport", "Transport", named(["local", "lan", "tailscale", "relay"])),
      toggle("remote.hostedPairingLink", "Pairing links open app.acehq.dev"),
      menu("remote.agentAccess", "Other machines' agents", named(["off", "read", "operate"])),
      {
        kind: "static",
        key: "remote.relayUrl",
        title: "Relay address",
        control: { kind: "text", placeholder: "wss://" },
      },
    ],
    savedHere,
  ),
  browser: one(
    "browser",
    "Browser and computer",
    [
      menu("browser.backend", "Browser", named(["auto", "embedded", "headless"])),
      menu("browser.backendLoss", "When browser disconnects", named(["pause", "headless"])),
      menu("browser.profile", "Browser data", named(["persistent", "ephemeral"])),
      menu("browser.profileScope", "Browser profile", named(["global", "project", "thread"])),
      {
        kind: "static",
        key: "browser.downloadDir",
        title: "Download folder on machine",
        control: { kind: "text", placeholder: "Folder path" },
      },
      toggle("browser.userChrome.storageReads", "Agents can read Chrome storage"),
    ],
    savedHere,
  ),
  computer: one(
    "computer",
    "App access and devices",
    [
      {
        kind: "static",
        key: "computer.blockedApps",
        title: "Apps agents can't use",
        control: { kind: "list", placeholder: "App name or bundle ID", add: "Add app" },
      },
      toggle("devices.emulatorWindow", "Show emulator window"),
    ],
    "Password managers, terminals and ace itself are always blocked.",
  ),
  fleet: one(
    "fleet",
    "Fleet",
    [
      toggle("remote.agentTransfers", "Agents can move projects and threads to other machines"),
      toggle("remote.transferIgnoredFiles", "Bring ignored files"),
    ],
    "With Bring ignored files, local files Git ignores, such as .env and local config, go too. Dependency folders are rebuilt there instead.",
  ),
};
