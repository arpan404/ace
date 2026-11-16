import { spadeJson, spadeRecord } from "./json.ts";

/*
 * A bot's plugins page (ADR 0151, spade/docs/plugins.md): the person's plugins accepted in ace,
 * which this bot may use, what of each it uses, and what Spade doesn't use with why. Read
 * leniently: a field this client doesn't know is ignored, a malformed entry left out.
 */

export interface SpadePluginServer {
  name: string;
  /** `not_started`, `running`, `stopped` or `failed`; another word as sent. */
  state: string;
  tools: number;
  problem: string | undefined;
}

export interface SpadePluginNotUsed {
  what: string;
  reason: string;
}

export interface SpadePlugin {
  name: string;
  version: string;
  enabledInAce: boolean;
  allowed: boolean;
  rules: string[];
  hooks: string[];
  servers: SpadePluginServer[];
  remote: { name: string; url: string }[];
  notUsed: SpadePluginNotUsed[];
}

export interface SpadeBotPlugins {
  plugins: SpadePlugin[];
  /** The bot runs on a subscription: it gets only rules. */
  cli: boolean;
  problem: string | undefined;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

function plugin(value: unknown): SpadePlugin | undefined {
  const record = spadeRecord(value);
  const name = text(record?.name);
  if (!record || !name) return undefined;
  const list = (key: string) => (Array.isArray(record[key]) ? (record[key] as unknown[]) : []);
  return {
    name,
    version: text(record.version) ?? "",
    enabledInAce: record.enabled_in_ace !== false,
    allowed: record.allowed === true,
    rules: strings(record.rules),
    hooks: strings(record.hooks),
    servers: list("servers").flatMap((each) => {
      const server = spadeRecord(each);
      const serverName = text(server?.name);
      if (!server || !serverName) return [];
      return [
        {
          name: serverName,
          state: text(server.state) ?? "not_started",
          tools: typeof server.tools === "number" ? server.tools : 0,
          problem: text(server.problem),
        },
      ];
    }),
    remote: list("remote").flatMap((each) => {
      const server = spadeRecord(each);
      const remoteName = text(server?.name);
      const url = text(server?.url);
      return remoteName && url ? [{ name: remoteName, url }] : [];
    }),
    notUsed: list("not_used").flatMap((each) => {
      const entry = spadeRecord(each);
      const what = text(entry?.what);
      const reason = text(entry?.reason);
      return what && reason ? [{ what, reason }] : [];
    }),
  };
}

export function parseSpadeBotPlugins(body: string): SpadeBotPlugins | undefined {
  const record = spadeRecord(spadeJson(body));
  if (!record || !Array.isArray(record.plugins)) return undefined;
  return {
    plugins: record.plugins.flatMap((each) => plugin(each) ?? []),
    cli: record.cli === true,
    problem: text(record.problem),
  };
}

const counted = (count: number, one: string) =>
  count === 0 ? undefined : `${count} ${one}${count === 1 ? "" : "s"}`;

/** What a plugin brings this bot, in a few words, for its row. */
export function spadePluginLine(entry: SpadePlugin): string {
  if (!entry.enabledInAce) return "Turned off in ace";
  const failed = entry.servers.find((server) => server.state === "failed");
  if (failed) return `${failed.name} stopped too often. Turn the plugin off and on to retry`;
  const parts = [
    counted(entry.rules.length, "rule"),
    counted(entry.hooks.length, "hook"),
    counted(entry.servers.length + entry.remote.length, "server"),
  ].filter((part): part is string => part !== undefined);
  return parts.length ? parts.join(", ") : "Nothing Spade uses";
}
