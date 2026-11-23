import {
  parseSpadeBotPlugins,
  parseSpadeConnectorAccess,
  parseSpadeConnectors,
  parseSpadeMove,
  parseSpadeTree,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import {
  spadeAppsRow,
  spadeDeleteRow,
  spadeMoveRow,
  spadeNextAccess,
  spadeNextPlugins,
  spadePluginsRow,
  type SpadeAppsRow,
  type SpadeDeleteRow,
  type SpadeMoveRow,
  type SpadePluginsRow,
} from "./spade-profile-access.ts";
import { segment } from "./spade-text.ts";
import {
  spadeRefused,
  spadeRequestArea,
  type SpadeAsk,
  type SpadeOutcome,
} from "./spade-requests-area.ts";

/*
 * What a bot may use and where it lives, from its iPhone profile: its apps and plugins, its move
 * to another of the person's machines, and Delete. A move starts here, on the machine the bot
 * leaves; once packed, Swift asks the machine it goes to to accept it (`spade.move.accept`),
 * since each machine runs in its own runtime. Shaped by `spade-profile-access.ts`.
 */

const agentId = z.string().min(1).max(256);
const id = z.string().min(1).max(256);
/** A move's id as Spade takes it: one plain lowercase name. */
const moveId = z.string().regex(/^mv_[0-9a-f]{1,64}$/);

const noBot = { ok: false, title: "", message: "Spade hasn't listed this bot yet." } as const;

type Part<T> = { ok: true; part: T };

export const spadeProfileActionRequests = spadeRequestArea(
  [
    z.object({ type: z.literal("spade.apps"), agentId }),
    z.object({ type: z.literal("spade.app"), agentId, connector: id, on: z.boolean() }),
    z.object({ type: z.literal("spade.plugins"), agentId }),
    z.object({ type: z.literal("spade.plugin"), agentId, name: id, on: z.boolean() }),
    /** The bot's move as Spade says it now, or what needs the person since it arrived. */
    z.object({ type: z.literal("spade.move.read"), agentId }),
    /** Starts moving the bot to the machine with ace host id `to`, as the move `move`. */
    z.object({ type: z.literal("spade.move.start"), agentId, to: id, move: moveId }),
    /** On the machine the bot goes to: the person accepts the move exactly as packed. */
    z.object({
      type: z.literal("spade.move.accept"),
      move: moveId,
      accept: z.object({
        bot: id,
        from: id,
        via: id,
        to: id,
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        replaces: z.enum(["bot", "main"]),
      }),
    }),
    z.object({
      type: z.literal("spade.move.end"),
      agentId,
      /** Cancel or dismiss the move, ask the other machine again, or dismiss the arrival. */
      action: z.enum(["cancel", "check", "arrival"]),
    }),
    /** What deleting the bot asks first, from its tree read now. */
    z.object({ type: z.literal("spade.delete.ask"), agentId }),
    z.object({
      type: z.literal("spade.delete"),
      agentId,
      workers: z.enum(["stop", "keep"]).optional(),
    }),
  ],
  async (
    { spade, ask },
    request,
  ): Promise<
    | SpadeOutcome
    | Part<SpadeAppsRow>
    | Part<SpadePluginsRow>
    | Part<SpadeMoveRow | null>
    | Part<SpadeDeleteRow>
  > => {
    if (request.type === "spade.move.accept")
      try {
        await ask("PUT", `/v1/moves/${segment(request.move)}/accept`, request.accept);
        return { ok: true };
      } catch (error) {
        return spadeRefused("Couldn't move it here", error);
      }
    const bot = spade.bot(request.agentId);
    if (!bot) return noBot;
    const path = `/v1/agents/${segment(request.agentId)}`;
    try {
      switch (request.type) {
        case "spade.apps":
        case "spade.app": {
          const [access, connectors] = await appsFacts(ask, path);
          if (request.type === "spade.apps")
            return { ok: true, part: spadeAppsRow(access, connectors) };
          const next = spadeNextAccess(access, connectors, request.connector, request.on);
          const saved = sure(
            parseSpadeConnectorAccess(await ask("PUT", `${path}/connectors`, next)),
            "allow list",
          );
          return { ok: true, part: spadeAppsRow(saved, connectors) };
        }
        case "spade.plugins":
        case "spade.plugin": {
          const page = sure(parseSpadeBotPlugins(await ask("GET", `${path}/plugins`)), "plugins");
          if (request.type === "spade.plugins") return { ok: true, part: spadePluginsRow(page) };
          const plugins = spadeNextPlugins(page, request.name, request.on);
          const saved = sure(
            parseSpadeBotPlugins(await ask("PUT", `${path}/plugins`, { plugins })),
            "plugins",
          );
          return { ok: true, part: spadePluginsRow(saved) };
        }
        case "spade.move.read":
          return { ok: true, part: spadeMoveRow(bot, moveOf(await ask("GET", `${path}/move`))) };
        case "spade.move.start": {
          const body = await ask("POST", `${path}/move`, { to: request.to, move: request.move });
          spade.refresh();
          return { ok: true, part: spadeMoveRow(bot, moveOf(body)) };
        }
        case "spade.move.end":
          if (request.action === "cancel") await ask("DELETE", `${path}/move`);
          else if (request.action === "check") await ask("POST", `${path}/move/check`, {});
          else await ask("DELETE", `${path}/arrival`);
          spade.refresh();
          return { ok: true };
        case "spade.delete.ask": {
          // A tree that can't be read asks nothing; Spade refuses a delete that should have.
          const tree = await ask("GET", `${path}/tree`).then(parseSpadeTree, () => undefined);
          return { ok: true, part: spadeDeleteRow(tree) };
        }
        case "spade.delete":
          if (bot.kind === "main")
            return { ok: false, title: "", message: "Spade can't be deleted." };
          await ask("DELETE", request.workers ? `${path}?workers=${request.workers}` : path);
          spade.refresh();
          return { ok: true };
      }
    } catch (error) {
      return spadeRefused(failures[request.type](bot.name), error);
    }
  },
);

const failures = {
  "spade.apps": () => "Couldn't read its apps",
  "spade.app": () => "Couldn't change its apps",
  "spade.plugins": () => "Couldn't read its plugins",
  "spade.plugin": () => "Couldn't change its plugins",
  "spade.move.read": () => "Couldn't read the move",
  "spade.move.start": (name: string) => `Couldn't move ${name}`,
  "spade.move.end": () => "Couldn't change the move",
  "spade.delete.ask": () => "Couldn't read its workers",
  "spade.delete": (name: string) => `Couldn't delete ${name}`,
} as const;

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

function moveOf(body: string) {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" && "move" in parsed
      ? parseSpadeMove(parsed.move)
      : undefined;
  } catch {
    return undefined;
  }
}

async function appsFacts(ask: SpadeAsk, path: string) {
  const [access, catalogue] = await Promise.all([
    ask("GET", `${path}/connectors`).then((body) =>
      sure(parseSpadeConnectorAccess(body), "allow list"),
    ),
    ask("GET", "/v1/connectors").then((body) => sure(parseSpadeConnectors(body), "connectors")),
  ]);
  return [access, catalogue.connectors] as const;
}
