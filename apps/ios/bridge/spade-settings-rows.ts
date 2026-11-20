import {
  spadeConnectorHealth,
  spadeConnectorLine,
  spadeFirstUsableModel,
  spadeFirstUsableWords,
  spadeLastUsedWords,
  spadeModelGroups,
  spadeModelLabel,
  spadePresetChoices,
  type SpadeConnector,
  type SpadeEndpoint,
  type SpadeModelSources,
  type SpadeModels,
  type SpadeSearchSettings,
  type SpadeSkillStore,
} from "@ace/ui-core/spade-chat";
import { utf8Bytes } from "./spade-profile.ts";

/*
 * Settings › Spade's pages as the phone draws them (web's Settings › Spade): General's models,
 * Models and keys, Web search and Apps, every word decided here. Pure. A key's value never
 * appears in any row: Spade only says whether one is set, and where it comes from (ADR 0119).
 */

/** The models General sets, in web's order, each with its empty choice's words. */
export const spadeModelRoles = ["new_bot", "fast", "transcription", "speech"] as const;
export type SpadeModelRole = (typeof spadeModelRoles)[number];

export interface SpadeModelChoiceRow {
  value: string;
  name: string;
}
export interface SpadeModelGroupRow {
  /** The endpoint or subscription the models come from. */
  label: string;
  choices: SpadeModelChoiceRow[];
}
export interface SpadeModelSettingRow {
  role: SpadeModelRole;
  title: string;
  /** A short line only where the title isn't enough. */
  line: string | null;
  /** `endpoint/model`, or "" for the empty choice. */
  value: string;
  /** What it is now: "Claude Sonnet 4.5 · Anthropic", or the empty choice's words. */
  words: string;
  /** The empty choice's words ("Each bot's own"). */
  none: string;
}

/** What the model choices may weigh in UTF-8, so a page travels in one 32 KiB frame. */
export const spadeChoicesBudget = 24_000;

const label = (shown: { name: string; source: string | undefined }) =>
  shown.source ? `${shown.name} · ${shown.source}` : shown.name;

/** One model setting: its value, and its words as the picker's button would say them. */
export function spadeModelSetting(
  role: SpadeModelRole,
  models: SpadeModels,
  sources: SpadeModelSources,
): SpadeModelSettingRow {
  const first = spadeFirstUsableModel(models.endpoints);
  const row = (title: string, line: string | null, value: string | undefined, none: string) => ({
    role,
    title,
    line,
    value: value ?? "",
    words: label(spadeModelLabel(sources, value ?? "", none)),
    none,
  });
  switch (role) {
    case "new_bot": {
      const set = row("Model for new bots", null, models.newBotModel, spadeFirstUsableWords(first));
      // Left to the default, the words name the model it comes to.
      return set.value || !first ? set : { ...set, words: label(spadeModelLabel(sources, first)) };
    }
    case "fast":
      return row("Fast model", "Titles and other small jobs", models.fastModel, "Each bot's own");
    case "transcription":
      return row(
        "Transcription",
        "Dictation and voice, when this device can't",
        models.transcriptionModel,
        "Off",
      );
    case "speech":
      return row(
        "Speech",
        "Reads replies aloud; the system's voices when off",
        models.speechModel,
        "System voices",
      );
  }
}

/**
 * Every model to pick from, grouped by where it comes from, held to `spadeChoicesBudget`: past
 * it, the longest group's last model goes until the rest fit, and `more` counts what went.
 */
export function spadeModelChoices(sources: SpadeModelSources): {
  groups: SpadeModelGroupRow[];
  more: number;
} {
  const groups = spadeModelGroups(sources, "").flatMap((group) =>
    group.label === undefined
      ? []
      : [
          {
            label: group.label,
            choices: group.options.map(({ value, name }) => ({ value, name })),
          },
        ],
  );
  const weigh = (choice: SpadeModelChoiceRow) => utf8Bytes(JSON.stringify(choice)) + 1;
  let bytes = groups.reduce(
    (sum, group) =>
      sum +
      utf8Bytes(group.label) +
      32 +
      group.choices.reduce((inner, choice) => inner + weigh(choice), 0),
    0,
  );
  let more = 0;
  while (bytes > spadeChoicesBudget) {
    const longest = groups.reduce((a, b) => (b.choices.length > a.choices.length ? b : a));
    const dropped = longest.choices.pop();
    if (!dropped) break;
    bytes -= weigh(dropped);
    more++;
  }
  return { groups: groups.filter((group) => group.choices.length > 0), more };
}

export interface SpadeKeyRow {
  words: string;
  set: boolean;
  /** A key can be typed here: the endpoint takes one and this machine has a keychain. */
  canSet: boolean;
  /** Only a keychain key can be removed from here; one from the environment stays. */
  canRemove: boolean;
}

export interface SpadeEndpointRow {
  id: string;
  name: string;
  /** Its server, as a person reads it: `api.anthropic.com`. */
  address: string;
  key: SpadeKeyRow;
  /** Its models' names, the first few. */
  models: string[];
  more: number;
}

export interface SpadeModelsPageRow {
  endpoints: SpadeEndpointRow[];
  /** Services the person can add, by their plain names, less those already added. */
  presets: { id: string; name: string }[];
  keychain: boolean;
  /** Where keys live, in a sentence under the endpoints. */
  note: string;
}

/** Models each endpoint names before the rest stay on the computer. */
const modelsShown = 12;

const hostOf = (address: string) => {
  try {
    return new URL(address).host || address;
  } catch {
    return address;
  }
};

function keyRow(endpoint: SpadeEndpoint, keychain: boolean): SpadeKeyRow {
  if (!endpoint.needsKey)
    return { words: "No key needed", set: false, canSet: false, canRemove: false };
  if (endpoint.keySet === undefined)
    return { words: "Checking the keychain…", set: false, canSet: false, canRemove: false };
  const canSet = keychain;
  if (!endpoint.keySet) return { words: "No key yet", set: false, canSet, canRemove: false };
  return endpoint.keySource === "environment"
    ? { words: "Key from the environment", set: true, canSet, canRemove: false }
    : { words: "Key in this machine's keychain", set: true, canSet, canRemove: true };
}

export function spadeModelsPage(models: SpadeModels): SpadeModelsPageRow {
  const added = new Set(models.endpoints.map((endpoint) => hostOf(endpoint.baseUrl)));
  return {
    endpoints: models.endpoints.map((endpoint) => ({
      id: endpoint.id,
      name: endpoint.name,
      address: hostOf(endpoint.baseUrl),
      key: keyRow(endpoint, models.keychain),
      models: endpoint.models.slice(0, modelsShown).map((model) => model.name),
      more: Math.max(0, endpoint.models.length - modelsShown),
    })),
    presets: spadePresetChoices(models.presets)
      .filter(({ preset }) => !added.has(hostOf(preset.baseUrl)))
      .map(({ preset, label: name }) => ({ id: preset.id, name })),
    keychain: models.keychain,
    note: models.keychain
      ? "Keys stay in this machine's keychain. You can replace or remove one from here, but never read it back."
      : "This machine has no keychain to keep keys in. Set each key in Spade's environment on the machine instead.",
  };
}

export interface SpadeSearchPageRow {
  searxng: string | null;
  brave: { set: boolean; words: string; canSet: boolean };
  keychain: boolean;
}

export function spadeSearchPage(settings: SpadeSearchSettings): SpadeSearchPageRow {
  return {
    searxng: settings.searxngUrl,
    brave: {
      set: settings.braveKeySet,
      words: settings.braveKeySet ? "Key in this machine's keychain" : "No key",
      canSet: settings.keychain,
    },
    keychain: settings.keychain,
  };
}

export interface SpadeAppRow {
  id: string;
  name: string;
  /** Working, Needs reconnect, or the device sign-in's sentence. */
  health: string;
  ok: boolean;
  account: string | null;
  /** The bots that use it, and when one last did. */
  line: string;
}

export interface SpadeAppsPageRow {
  apps: SpadeAppRow[];
  /** Skills the bots use or wrote, or written in Spade, each with those bots. */
  skills: { name: string; line: string }[];
}

const named = (ids: readonly string[], names: ReadonlyMap<string, string>) =>
  ids.flatMap((id) => {
    const name = names.get(id);
    return name ? [name] : [];
  });

function appRow(connector: SpadeConnector, names: ReadonlyMap<string, string>, now: number) {
  const users = named(connector.bots, names);
  return {
    id: connector.id,
    name: connector.name,
    health: connector.device ? spadeConnectorLine(connector) : spadeConnectorHealth(connector),
    ok: connector.state === "connected",
    account: connector.account ?? null,
    line: [
      users.length ? users.join(", ") : "No bot uses it",
      spadeLastUsedWords(connector.lastUsedMs, now),
    ].join(" · "),
  };
}

export function spadeAppsPage(
  connectors: readonly SpadeConnector[],
  store: SpadeSkillStore | undefined,
  names: ReadonlyMap<string, string>,
  now: number,
): SpadeAppsPageRow {
  const skills = (store?.skills ?? []).flatMap((skill) => {
    const users = named(skill.usedBy, names);
    const writers = named(skill.writtenBy, names).filter((name) => !users.includes(name));
    // As web lists them: one a bot uses or wrote, or one written in Spade.
    if (!users.length && !writers.length && skill.origin !== "spade") return [];
    const line = [users.join(", "), writers.length ? `Written by ${writers.join(", ")}` : ""]
      .filter(Boolean)
      .join(" · ");
    return [{ name: skill.name, line: line || skill.description }];
  });
  return { apps: connectors.map((connector) => appRow(connector, names, now)), skills };
}
