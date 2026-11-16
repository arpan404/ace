import { z } from "zod";
import type { SpadeConnection } from "../spade/forward.ts";
import { spadeRequest } from "../spade/forward.ts";
import type { MadeBot, SpadePort } from "./install.ts";

/*
 * What the marketplace asks of Spade through the daemon's link (ADR 0168 §8, §13): a new bot made
 * from a recipe (`POST /v1/agents` with `recipe`), and a plugin allowed for the bots the person
 * picked (ADR 0151 point 8, `PUT /v1/agents/{id}/plugins`).
 */

const Made = z.object({
  agent: z.object({ id: z.string().min(1).max(80) }),
  left_out: z.array(z.string().max(500)).max(64).optional(),
});
const Agents = z.object({
  agents: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        from_recipe: z.object({ transaction: z.string().max(80).optional() }).nullish(),
      }),
    )
    .max(10_000),
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

async function call(
  connection: SpadeConnection,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
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
  return text ? JSON.parse(text) : undefined;
}

export function spadePort(connection: () => SpadeConnection | undefined): SpadePort {
  const live = () => {
    const current = connection();
    if (!current) throw new Error("Spade isn't running. Start Spade to make this bot.");
    return current;
  };
  return {
    ready: () => connection() !== undefined,
    async createBot(input): Promise<MadeBot> {
      const { recipe } = input;
      const made = Made.parse(
        await call(live(), "POST", "/v1/agents", {
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
          },
          // Spade answers a second request with the same transaction with the bot it made.
          from_recipe: { ...input.fromRecipe, transaction: input.transaction },
          grants: input.grants,
          start_routines: input.startRoutines,
        }),
      );
      return { id: made.agent.id, leftOut: made.left_out ?? [] };
    },
    async pluginsOf(bot) {
      const path = `/v1/agents/${encodeURIComponent(bot)}/plugins`;
      const current = BotPlugins.parse(await call(live(), "GET", path));
      return current.plugins
        .filter((item) => item.allowed)
        .map((item) => item.name)
        .toSorted();
    },
    async setPlugins(bot, plugins) {
      await call(live(), "PUT", `/v1/agents/${encodeURIComponent(bot)}/plugins`, {
        plugins: [...new Set(plugins)].toSorted(),
      });
    },
    async findBot(transaction) {
      const listed = Agents.parse(await call(live(), "GET", "/v1/agents"));
      return listed.agents.find((agent) => agent.from_recipe?.transaction === transaction)?.id;
    },
    async deleteBot(id) {
      // Workers it made in the moments it existed stop with it.
      await call(live(), "DELETE", `/v1/agents/${encodeURIComponent(id)}?workers=stop`);
    },
  };
}
