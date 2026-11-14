import type { SettingsKey } from "@ace/protocol";
import {
  accessLabel,
  accessModes,
  agentSettingTitles,
  atLimitLine,
  autoSettleChoices,
  browserDownloadsNote,
  browserEngineChoices,
  browserLossChoices,
  browserProfileChoices,
  browserProfileScopeChoices,
  childLimitChoices,
  childLimitNote,
  devicesSwitch,
  emulatorWindowSwitch,
  followUpChoices,
  limitPolicyChoices,
  remotePushSwitch,
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

/** What a change asks before it is made. */
export interface ControlAsk {
  title: string;
  message: string;
  confirm: string;
}

export type StaticControl =
  | {
      kind: "toggle";
      /** Asked before turning it off, when that stops work in progress. */
      askOff?: ControlAsk;
    }
  | { kind: "choice"; style: "menu" | "segmented"; choices: (current: unknown) => ChoiceSpec[] }
  | { kind: "text"; placeholder: string }
  | { kind: "number" }
  | { kind: "list"; placeholder: string; add: string };

export interface StaticRow {
  kind: "static";
  key: SettingsKey;
  title: string;
  control: StaticControl;
  /** What the current value means, when that changes with it; `other` reads `reads`' values. */
  note?: (current: unknown, other: (key: SettingsKey) => unknown) => string | null;
  /** Other settings the note depends on, read with the page. */
  reads?: SettingsKey[];
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

/** The web's machine marks, in its order; a pick keeps the machine's colour. */
const machineIcons = [
  ["laptop", "Laptop"],
  ["desktop", "Desktop"],
  ["monitor", "Monitor"],
  ["server", "Server"],
  ["cloud", "Cloud"],
  ["cpu", "CPU"],
  ["terminal", "Terminal"],
  ["phone", "Phone"],
] as const;
function iconChoices(current: unknown): ChoiceSpec[] {
  const color =
    current && typeof current === "object" && "color" in current ? current.color : undefined;
  return machineIcons.map(([kind, label]) => {
    const value = color === undefined ? { kind } : { kind, color };
    return { id: choiceId(value), label, value };
  });
}

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
      {
        kind: "static",
        key: "host.icon",
        title: "Icon",
        control: { kind: "choice", style: "menu", choices: iconChoices },
      },
      toggle("remote.enabled", "Remote connections"),
      toggle("remote.lan", "Local network"),
      toggle("remote.tailscale", "Tailscale"),
      toggle("remote.relay", "Relay"),
      toggle("remote.hostedPairingLink", "Pairing links open app.acehq.dev"),
      menu("remote.agentAccess", "Other machines' agents", named(["off", "read", "operate"])),
      {
        kind: "static",
        key: "remote.relayUrl",
        title: "Your own relay",
        control: { kind: "text", placeholder: "Empty: ace's relay" },
      },
    ],
    savedHere,
  ),
  /** ace's Chrome on the machine, as web's Settings › Browser words it. */
  browser: {
    id: "browser",
    title: "Browser",
    sections: [
      {
        id: "chrome",
        title: "ace's Chrome",
        footer: "ace's Chrome keeps agents browsing without the app. Saved on this machine.",
        rows: [
          menu("browser.backend", "Browser engine", choices(browserEngineChoices)),
          {
            kind: "static",
            key: "browser.profile",
            title: "New browsers",
            control: {
              kind: "choice",
              style: "segmented",
              choices: choices(browserProfileChoices),
            },
          },
          menu(
            "browser.profileScope",
            "Browser profile",
            choices(browserProfileScopeChoices),
            () => "A project can choose its own in Edit project.",
          ),
          {
            kind: "static",
            key: "browser.backendLoss",
            title: "When the desktop app goes away",
            control: { kind: "choice", style: "segmented", choices: choices(browserLossChoices) },
          },
          {
            kind: "static",
            key: "browser.downloadDir",
            title: "Downloads folder for ace's Chrome",
            control: { kind: "text", placeholder: "Folder path" },
            reads: ["browser.downloadDefault"],
            note: (_current, other) => {
              const machine = other("browser.downloadDefault");
              return browserDownloadsNote(typeof machine === "string" ? machine : "");
            },
          },
        ],
      },
      {
        id: "userChrome",
        title: "Use my Chrome",
        footer: "Set up Use my Chrome in Computer use.",
        rows: [
          toggle("browser.userChrome.storageReads", "Let agents read cookies and site storage"),
        ],
      },
    ],
  },
  computer: one(
    "computer",
    "App access",
    [
      {
        kind: "static",
        key: "computer.blockedApps",
        title: "Apps agents can't use",
        control: { kind: "list", placeholder: "App name or bundle ID", add: "Add app" },
      },
    ],
    "Password managers, terminals and ace itself are always blocked.",
  ),
  simulators: {
    id: "simulators",
    title: "Simulators",
    sections: [
      {
        id: "simulators",
        title: "Simulators and emulators",
        footer: devicesSwitch.description,
        rows: [
          {
            kind: "static",
            key: "devices.enabled",
            title: devicesSwitch.title,
            control: { kind: "toggle", askOff: devicesSwitch.askOff },
          },
        ],
      },
      {
        id: "emulator",
        title: null,
        footer: emulatorWindowSwitch.description,
        rows: [toggle("devices.emulatorWindow", emulatorWindowSwitch.title)],
      },
    ],
  },
  /** Whether this machine pushes its phones' alerts while the app is closed (ADR 0106). */
  notifications: one(
    "notifications",
    "Notifications",
    [toggle("notifications.remotePush", remotePushSwitch.title)],
    remotePushSwitch.description,
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
