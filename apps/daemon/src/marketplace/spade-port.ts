import { z } from "zod";
import { MarketBotReplay, PackagePlan } from "@ace/protocol/marketplace";
import type { SpadeConnection } from "../spade/forward.ts";
import { spadeRequest } from "../spade/forward.ts";
import type { MadeBot, PackageInput, SpadePort } from "./install.ts";

/*
 * What the marketplace asks of Spade through the daemon's link (ADR 0168 §8, §13): a new bot made
 * from a recipe (`POST /v1/agents` with `recipe`), and a plugin allowed for the bots the person
 * picked (ADR 0151 point 8, `PUT /v1/agents/{id}/plugins`), and the market's signed terms
 * notices (ADR 0205 §4, `PUT /v1/subscriptions/notices`).
 */

const Made = z.object({
  agent: z.object({ id: z.string().min(1).max(80) }),
  left_out: z.array(z.string().max(500)).max(64).optional(),
});
const Version = z.object({ version: z.string().min(1).max(64), hash: z.string().min(1).max(128) });
const Linked = Version.extend({
  source: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  previous: Version.nullish().catch(undefined),
  held: z
    .object({ version: z.string().min(1).max(64) })
    .nullish()
    .catch(undefined),
});
const Agents = z.object({
  agents: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        from_recipe: z.object({ transaction: z.string().max(80).optional() }).nullish(),
        // A link this build can't read is no link: the bot stays as Spade has it.
        package: Linked.nullish().catch(undefined),
      }),
    )
    .max(10_000),
});
const PackageRoutes = z.object({
  fast: z.object({ tools: z.boolean() }),
  capable: z.object({ tools: z.boolean() }),
});
const BotPlugins = z.object({
  plugins: z.array(z.object({ name: z.string().max(64), allowed: z.boolean() })).max(1024),
});

/** Spade's error bodies say why under `error`. */
const Problem = z.object({
  error: z.string().max(300).optional(),
  detail: z.string().max(300).optional(),
});
const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const maxBytes = 1024 * 1024;

/** One request to Spade over the daemon's link, its JSON answer, or why Spade refused. */
export async function spadeCall(
  connection: SpadeConnection,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  return (await spadeCallStatus(connection, method, path, body)).body;
}

/** [`spadeCall`], with the status Spade answered: a held update is a 202. */
async function spadeCallStatus(
  connection: SpadeConnection,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const answer = await spadeRequest(
    connection,
    {
      method,
      path,
      ...(body === undefined
        ? {}
        : { body: Buffer.from(JSON.stringify(body)), contentType: "application/json" }),
    },
    { signal: AbortSignal.timeout(30_000), maxBytes },
  );
  if (answer.kind !== "response") throw new Error("Spade's answer was too large");
  const text = answer.body.toString("utf8");
  if (answer.status < 200 || answer.status >= 300) {
    const problem = Problem.safeParse(text ? safeJson(text) : undefined);
    const detail = problem.success ? (problem.data.error ?? problem.data.detail) : undefined;
    throw new Error(detail ? `Spade refused: ${detail}` : `Spade answered ${answer.status}`);
  }
  return { status: answer.status, body: text ? JSON.parse(text) : undefined };
}

const Planned = z.object({ plan: PackagePlan });
const Replayed = z.object({ replay: MarketBotReplay });

/**
 * A version 3 package's part of `POST /v1/agents`: `bot.json` as published, read by Spade's own
 * reader in place of the version 2 shape, its market identity, and the person's switches.
 */
function linked(input: Parameters<SpadePort["createBot"]>[0]["linked"]) {
  return input ? { ...identity(input), switches: input.switches } : {};
}

/** A package's manifest and, for a market one, what proves its identity to Spade. */
function identity(input: PackageInput) {
  return {
    recipe: input.manifest,
    ...(input.pages && Object.keys(input.pages).length > 0 ? { pages: input.pages } : {}),
    ...(input.code && Object.keys(input.code).length > 0 ? { code: input.code } : {}),
    ...(input.signed
      ? {
          package: input.signed.package,
          envelope: {
            signed: input.signed.signedManifest,
            bot_json: input.signed.botJson,
            ...(input.signed.contractFiles && Object.keys(input.signed.contractFiles).length > 0
              ? { files: input.signed.contractFiles }
              : {}),
          },
        }
      : {}),
  };
}

export function spadePort(
  connection: () => SpadeConnection | undefined,
  version: () => string | undefined = () => undefined,
): SpadePort {
  const live = () => {
    const current = connection();
    if (!current) throw new Error("Spade isn't running. Start Spade to make this bot.");
    return current;
  };
  return {
    ready: () => connection() !== undefined,
    version: () => (connection() ? version() : undefined),
    async createBot(input): Promise<MadeBot> {
      const { recipe } = input;
      const made = Made.parse(
        await spadeCall(live(), "POST", "/v1/agents", {
          recipe: {
            format: recipe.format,
            version: recipe.version,
            name: recipe.name,
            blurb: recipe.blurb,
            task: recipe.task,
            ...(recipe.face ? { face: recipe.face } : {}),
            model: recipe.model,
            routines: recipe.routines,
            ...(recipe.needs.tools ? { tools: recipe.needs.tools } : {}),
            notes: recipe.notes,
            ...(recipe.personality ? { personality: recipe.personality } : {}),
          },
          // Spade answers a second request with the same transaction with the bot it made.
          from_recipe: { ...input.fromRecipe, transaction: input.transaction },
          grants: input.grants,
          start_routines: input.startRoutines,
          ...linked(input.linked),
        }),
      );
      return { id: made.agent.id, leftOut: made.left_out ?? [] };
    },
    async planUpdate(bot, manifest) {
      const path = `/v1/agents/${encodeURIComponent(bot)}/package/plan`;
      return Planned.parse(await spadeCall(live(), "POST", path, { recipe: manifest })).plan;
    },
    async replayUpdate(bot, manifest, pages) {
      const path = `/v1/agents/${encodeURIComponent(bot)}/cases/replay`;
      const body = { recipe: manifest, ...(Object.keys(pages).length > 0 ? { pages } : {}) };
      return Replayed.parse(await spadeCall(live(), "POST", path, body)).replay;
    },
    async updateBot(bot, input) {
      const answer = await spadeCallStatus(
        live(),
        "POST",
        `/v1/agents/${encodeURIComponent(bot)}/package`,
        { ...identity(input), transaction: input.transaction },
      );
      // 202: the bot works, and Spade applies the step when its turn ends.
      return { held: answer.status === 202 };
    },
    async withdrawBot(bot, reason) {
      const path = `/v1/agents/${encodeURIComponent(bot)}/package/withdrawn`;
      await spadeCall(live(), "POST", path, { reason });
    },
    async resumeBot(bot) {
      const path = `/v1/agents/${encodeURIComponent(bot)}/package/withdrawn`;
      await spadeCall(live(), "DELETE", path);
    },
    async pluginsOf(bot) {
      const path = `/v1/agents/${encodeURIComponent(bot)}/plugins`;
      const current = BotPlugins.parse(await spadeCall(live(), "GET", path));
      return current.plugins
        .filter((item) => item.allowed)
        .map((item) => item.name)
        .toSorted();
    },
    async setPlugins(bot, plugins) {
      await spadeCall(live(), "PUT", `/v1/agents/${encodeURIComponent(bot)}/plugins`, {
        plugins: [...new Set(plugins)].toSorted(),
      });
    },
    async findBot(transaction) {
      const listed = Agents.parse(await spadeCall(live(), "GET", "/v1/agents"));
      return listed.agents.find((agent) => agent.from_recipe?.transaction === transaction)?.id;
    },
    async bots() {
      const listed = Agents.parse(await spadeCall(live(), "GET", "/v1/agents"));
      const links = listed.agents.flatMap((agent) => {
        const link = agent.package;
        if (!link) return [];
        const { previous, held, ...current } = link;
        return [
          {
            id: agent.id,
            package: current,
            ...(previous ? { previous } : {}),
            ...(held ? { held } : {}),
          },
        ];
      });
      return { ids: new Set(listed.agents.map((agent) => agent.id)), linked: links };
    },
    async packageTools() {
      const routes = PackageRoutes.parse(
        await spadeCall(live(), "GET", "/v1/models/package-routes"),
      );
      return { fast: routes.fast.tools, capable: routes.capable.tools };
    },
    async termsNotices(signed) {
      await spadeCall(live(), "PUT", "/v1/subscriptions/notices", { signed });
    },
    async deleteBot(id) {
      // Workers it made in the moments it existed stop with it.
      await spadeCall(live(), "DELETE", `/v1/agents/${encodeURIComponent(id)}?workers=stop`);
    },
  };
}
