import { agentToolCommands, agentToolNouns } from "./agent-tools.ts";
import { basicCommands } from "./basics.ts";
import { machineCommands, machineNouns } from "./machine.ts";
import { providerCommands, providerNouns } from "./providers.ts";
import { spadeMarketCommands, spadeMarketNouns } from "./spade-market.ts";
import type { AliasSpec, CommandSpec, NounSpec } from "./spec.ts";
import { workCommands, workNouns } from "./work.ts";

export const commands: readonly CommandSpec[] = [
  ...basicCommands,
  ...workCommands,
  ...machineCommands,
  ...providerCommands,
  ...spadeMarketCommands,
  ...agentToolCommands,
];

export const nouns: readonly NounSpec[] = [
  ...workNouns,
  ...machineNouns,
  ...providerNouns,
  ...spadeMarketNouns,
  ...agentToolNouns,
];

/** One way to reach a command: its own words, or one of its aliases. */
export interface Route {
  readonly command: CommandSpec;
  readonly alias?: AliasSpec;
}

export interface CommandTable {
  readonly commands: readonly CommandSpec[];
  readonly nouns: readonly NounSpec[];
  readonly byId: ReadonlyMap<string, CommandSpec>;
  /** Space-joined words to the route they reach. */
  readonly routes: ReadonlyMap<string, Route>;
  /** Space-joined prefixes (`thread`, `market maintainer`) to the words that may follow. */
  readonly next: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Indexes a table; throws when two routes claim the same words, so a test catches it. */
export function indexTable(
  list: readonly CommandSpec[],
  nounList: readonly NounSpec[],
): CommandTable {
  const byId = new Map<string, CommandSpec>();
  const routes = new Map<string, Route>();
  const next = new Map<string, Set<string>>();
  const add = (words: readonly string[], route: Route) => {
    const key = words.join(" ");
    const taken = routes.get(key);
    if (taken) throw new Error(`"${key}" reaches both ${taken.command.id} and ${route.command.id}`);
    routes.set(key, route);
    for (let i = 0; i < words.length; i++) {
      const prefix = words.slice(0, i).join(" ");
      const following = next.get(prefix) ?? new Set<string>();
      following.add(words[i] ?? "");
      next.set(prefix, following);
    }
  };
  for (const command of list) {
    if (byId.has(command.id)) throw new Error(`Two commands are ${command.id}`);
    byId.set(command.id, command);
    add(command.words, { command });
    for (const alias of command.aliases ?? []) add(alias.words, { command, alias });
  }
  for (const command of list)
    if (command.nounDefault && command.words.length > 1)
      add(command.words.slice(0, -1), { command });
  return { commands: list, nouns: nounList, byId, routes, next };
}

let cached: CommandTable | undefined;
/** The CLI's own table, indexed once. */
export function commandTable(): CommandTable {
  cached ??= indexTable(commands, nouns);
  return cached;
}
