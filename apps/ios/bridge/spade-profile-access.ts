import {
  spadeArrivalLine,
  spadeBotWorkers,
  spadeMoveLine,
  spadePluginLine,
  type SpadeAgent,
  type SpadeBotPlugins,
  type SpadeConnector,
  type SpadeConnectorAccess,
  type SpadeMove,
  type SpadeWorkerNode,
} from "@ace/ui-core/spade-chat";

/*
 * What a bot may use and where it runs, on its iPhone profile, as web's: its apps (ADR 0131),
 * its plugins (ADR 0151), its move to another machine (ADR 0187), and the one question deleting
 * a bot that made workers asks (ADR 0161). Pure: Spade's answers come in, Swift's rows go out,
 * and each change becomes what Spade takes.
 */

export interface SpadeAppsRow {
  /** The connected apps it may use, each with its account. */
  allowed: { id: string; name: string; account: string | null }[];
  /** Connected apps it doesn't have yet, for Add an app; one still signing in has nothing to give. */
  others: { id: string; name: string }[];
}

/** The connected apps this bot may use, by its allow list: all of them, or the ones named. */
function allowedOf(access: SpadeConnectorAccess, connectors: readonly SpadeConnector[]) {
  return access.all
    ? [...connectors]
    : connectors.filter((connector) => access.connectors.includes(connector.id));
}

export function spadeAppsRow(
  access: SpadeConnectorAccess,
  connectors: readonly SpadeConnector[],
): SpadeAppsRow {
  const allowed = allowedOf(access, connectors);
  return {
    allowed: allowed.map(({ id, name, account }) => ({ id, name, account: account ?? null })),
    others: connectors
      .filter((connector) => !allowed.includes(connector) && connector.state !== "signing_in")
      .map(({ id, name }) => ({ id, name })),
  };
}

/** The allow list after `app` is added or removed; removing narrows "all" to the rest. */
export function spadeNextAccess(
  access: SpadeConnectorAccess,
  connectors: readonly SpadeConnector[],
  app: string,
  on: boolean,
): SpadeConnectorAccess {
  const ids = access.all ? connectors.map((connector) => connector.id) : access.connectors;
  const next = on ? [...new Set([...ids, app])] : ids.filter((id) => id !== app);
  return { all: false, connectors: next };
}

export interface SpadePluginsRow {
  /** It runs on a subscription, so it gets only rules. */
  cli: boolean;
  problem: string | null;
  plugins: {
    name: string;
    line: string;
    on: boolean;
    /** Off in ace: off for every bot, and its switch can't turn on. */
    offInAce: boolean;
    /** What Spade doesn't use of it, one line each. */
    notes: string[];
  }[];
}

export function spadePluginsRow(page: SpadeBotPlugins): SpadePluginsRow {
  return {
    cli: page.cli,
    problem: page.problem ?? null,
    plugins: page.plugins.map((plugin) => ({
      name: plugin.name,
      line: spadePluginLine(plugin),
      on: plugin.allowed,
      offInAce: !plugin.enabledInAce,
      notes: [
        ...plugin.remote.map(
          (server) => `Server ${server.name} is used as an app: add ${server.url} in Apps.`,
        ),
        ...plugin.notUsed.map((entry) => `Not used by Spade: ${entry.what}: ${entry.reason}`),
      ],
    })),
  };
}

/** The plugins the bot may use after `name` is switched. */
export function spadeNextPlugins(page: SpadeBotPlugins, name: string, on: boolean): string[] {
  const allowed = page.plugins.filter((each) => each.allowed).map((each) => each.name);
  return on ? [...new Set([...allowed, name])] : allowed.filter((each) => each !== name);
}

/** What accepting the move on the machine it goes to names (ADR 0187). */
export interface SpadeMoveAccept {
  bot: string;
  from: string;
  via: string;
  to: string;
  digest: string;
  replaces: "bot" | "main";
}

export interface SpadeMoveRow {
  id: string | null;
  waitsForYou: boolean;
  /** One sentence: where it is going and how far, or why it failed, or what needs the person. */
  line: string;
  failed: boolean;
  /** Arrived from another machine: Dismiss is all there is. */
  arrived: boolean;
  /** It moves now: Move to… waits. */
  moving: boolean;
  canCancel: boolean;
  canKeep: boolean;
  /** Committing or aborting and the other machine can't be reached: Check again. */
  check: boolean;
  /** The machine it goes to, by ace host id: Try again after a failure goes there. */
  to: string | null;
  /** Once packed: what the person accepts on the machine it goes to. */
  accept: SpadeMoveAccept | null;
}

export function spadeMoveRow(agent: SpadeAgent, move: SpadeMove | undefined): SpadeMoveRow | null {
  if (move) {
    const failed = move.state === "failed";
    return {
      id: move.id,
      waitsForYou: move.state === "awaiting",
      line: spadeMoveLine(move, agent.name),
      failed,
      arrived: false,
      moving: !failed && move.state !== "done" && move.state !== "cancelled",
      canCancel: move.canCancel,
      canKeep: move.canKeep,
      check: (move.state === "committing" || move.state === "aborting") && move.waiting,
      to: move.to.host,
      accept: move.accept ? { bot: agent.id, to: move.to.host, ...move.accept } : null,
    };
  }
  if (!agent.arrived) return null;
  return {
    id: null,
    waitsForYou: false,
    line: spadeArrivalLine(agent.arrived),
    failed: false,
    arrived: true,
    moving: false,
    canCancel: false,
    canKeep: false,
    check: false,
    to: null,
    accept: null,
  };
}

const listed = (names: readonly string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;

export interface SpadeDeleteRow {
  /** The bot made other bots: delete asks whether to stop them or keep them going. */
  asks: boolean;
  /** What Stop its workers means: they stay as the person's own, stopped. */
  stop: string;
  /** What Keep its workers going means: they carry on as the person's own. */
  keep: string;
  /**
   * It started ace threads. Spade stops the bot it deletes, and that cancels them whichever way
   * its workers go (ADR 0161), so both answers and the plain confirm say so.
   */
  aceStops: boolean;
}

const aceStopLine = "Its ace threads stop.";

/** The one question a delete asks, from the bot's tree read fresh; none when it made no bots. */
export function spadeDeleteRow(tree: SpadeWorkerNode | undefined): SpadeDeleteRow {
  const workers = spadeBotWorkers(tree);
  const ace = tree?.children.some((child) => child.kind === "ace") === true;
  const own = workers.length === 1 ? "stays as your bot" : "stay as your bots";
  const bots = workers.length
    ? `${listed(workers.map((worker) => worker.name))} ${own}, stopped.`
    : "";
  const withAce = (line: string) => [line, ace ? aceStopLine : ""].filter(Boolean).join(" ");
  return {
    asks: workers.length > 0,
    stop: withAce(bots),
    keep: withAce(workers.length ? "They carry on as your own bots." : ""),
    aceStops: ace,
  };
}
