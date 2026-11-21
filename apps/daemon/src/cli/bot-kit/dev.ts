import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CliBotDev } from "@ace/protocol/cli-outputs";
import { CliFailure } from "../output.ts";
import type { SpadeAnswer, SpadeExchange } from "../spade-call.ts";
import { checkPackage, packageJson } from "./check.ts";
import { allOn, asksMore, devBotOf, devFolderKey, effectLines, installBody } from "./dev-plan.ts";

/*
 * `ace bot dev [PATH]` (ADR 0200 §9): the package installed on a Spade as a development bot,
 * linked to the local package of its name (`local/<name>`), through the same install path as the
 * market's, then updated on each save. The bot is the folder's: it is found again by the folder's
 * key kept with it, so renaming it in `bot.json` updates the same bot.
 * Every save is checked first; one that asks for more asks the person again; one that comes
 * while the bot works waits for its next quiet moment. Nothing here decides: `dev-plan.ts` does.
 */

/** How often a save that waits on a busy bot is tried again. */
const RETRY_MS = 2000;
/** Saves closer together than this are one change. */
const SETTLE_MS = 300;

export interface DevIo {
  readonly exchange: SpadeExchange;
  /** The person's yes to what a save asks for; false when nobody can answer. */
  readonly confirm: (question: string, lines: readonly string[]) => Promise<boolean>;
  readonly report: (step: CliBotDev) => Promise<void>;
  readonly wait: (ms: number) => Promise<void>;
}

/** A Spade data folder's own address and token: a development Spade, reached directly. */
export async function directExchange(folder: string): Promise<SpadeExchange> {
  const { readSpadeServerFile, readSpadeTokenFile } = await import("@ace/service/spade");
  const read = async (name: string) => readFile(join(folder, name), "utf8").catch(() => undefined);
  const server = readSpadeServerFile((await read("server.json")) ?? "");
  const token = readSpadeTokenFile((await read("token")) ?? "");
  if (!server.ok || !token)
    throw new CliFailure("refused", `No Spade is running from ${folder}.`, undefined, {
      code: "refused",
      hint: "Start it with SPADE_DATA_DIR set to that folder, then try again.",
    });
  const origin = `http://${server.endpoint.host}:${server.endpoint.port}`;
  return async (method, path, body): Promise<SpadeAnswer> => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.text() };
  };
}

const json = (answer: SpadeAnswer): unknown => {
  try {
    return JSON.parse(answer.body);
  } catch {
    return undefined;
  }
};

const said = (answer: SpadeAnswer) =>
  /"(?:error|message)"\s*:\s*"([^"]{1,300})"/.exec(answer.body)?.[1] ??
  `Spade answered ${answer.status}.`;

async function skillFolders(root: string): Promise<Set<string>> {
  const names = await readdir(join(root, "skills")).catch(() => [] as string[]);
  return new Set(names.map((name) => `skills/${name}`));
}

/** Each declared panel's page, as text by path: a save to one updates the bot (§5.2). */
export async function panelPages(root: string, surfaces: unknown): Promise<Record<string, string>> {
  const { panelFiles } = await import("@ace/marketplace");
  const pages: Record<string, string> = {};
  for (const path of panelFiles(surfaces).values()) {
    const page = await readFile(join(root, path), "utf8").catch(() => undefined);
    if (page !== undefined) pages[path] = page;
  }
  return pages;
}

/** The package as it is now: checked, read, its effect switches' keys and its panel pages. */
async function current(root: string) {
  const checked = await checkPackage(root);
  // As Spade reads it: its contracts' schema files written in (ADR 0200 §7).
  const recipe = (await packageJson(root)) as Record<string, unknown>;
  const { readRecipe, recipeEffects } = await import("@ace/marketplace");
  const read = readRecipe(JSON.stringify(recipe), await skillFolders(root));
  const keys = read.recipe ? recipeEffects(read.recipe).map((row) => row.key) : [];
  return { checked, recipe, keys, pages: await panelPages(root, recipe["surfaces"]) };
}

interface State {
  bot?: { id: string; name: string } | undefined;
  /** The content hash last applied in this run: a save that changes nothing is skipped. */
  hash?: string | undefined;
  /** The manifest last applied in this run, to see what a save adds. */
  applied?: Record<string, unknown> | undefined;
}

/** One pass: install the bot, or update it to the folder as it is now. */
export async function devStep(root: string, io: DevIo, state: State): Promise<CliBotDev> {
  const folder = await realpath(resolve(root));
  const now = await current(folder);
  const listed = await io.exchange("GET", "/v1/agents");
  if (listed.status !== 200) throw new CliFailure("failed", said(listed));
  const name = String(now.recipe["name"]);
  const folderKey = devFolderKey(folder);
  state.bot ??= devBotOf(json(listed), folderKey);
  const hash = now.checked.hash;
  if (!state.bot) {
    const ok = await io.confirm(
      `Install ${name} here as a development bot? Its routines start paused.`,
      effectLines(now.recipe),
    );
    if (!ok)
      throw new CliFailure("needs-human", "The development bot wasn't installed.", undefined, {
        code: "confirm",
        hint: "Run it in your own terminal to answer, or pass --yes.",
      });
    const made = await io.exchange(
      "POST",
      "/v1/agents",
      installBody({
        recipe: now.recipe,
        folder: folderKey,
        switches: allOn(now.keys),
        transaction: `dev-${randomUUID()}`,
        pages: now.pages,
      }),
    );
    if (made.status !== 201 && made.status !== 200)
      throw new CliFailure("failed", `It didn't install: ${said(made)}`);
    const agent = (json(made) as { agent?: { id?: string; name?: string } } | undefined)?.agent;
    state.bot = { id: agent?.id ?? "", name: agent?.name ?? name };
    state.hash = hash;
    state.applied = now.recipe;
    return { step: "installed", bot: state.bot.id, name: state.bot.name, hash };
  }
  const bot = state.bot;
  if (state.hash === hash) return { step: "unchanged", bot: bot.id, name: bot.name, hash };
  const planned = await io.exchange("POST", `/v1/agents/${bot.id}/package/plan`, {
    recipe: now.recipe,
  });
  if (planned.status !== 200) throw new CliFailure("failed", `It can't update: ${said(planned)}`);
  const asks = asksMore(json(planned), state.applied, now.recipe);
  if (asks.effects.length || asks.more.length) {
    const ok = await io.confirm(`This save asks for more. Update ${bot.name}?`, [
      ...asks.effects.map((key) => `effect ${key}`),
      ...asks.more,
    ]);
    if (!ok)
      return {
        step: "refused",
        bot: bot.id,
        name: bot.name,
        hash,
        why: ["It asks for more, and you said no. Change it back or run ace bot dev again."],
      };
  }
  const transaction = `dev-${randomUUID()}`;
  for (;;) {
    // No identity is claimed: a local package's update is the manifest it is moved to.
    const applied = await io.exchange("POST", `/v1/agents/${bot.id}/package`, {
      recipe: now.recipe,
      transaction,
      pages: now.pages,
    });
    if (applied.status === 200) break;
    if (applied.status !== 409)
      throw new CliFailure("failed", `It didn't update: ${said(applied)}`);
    await io.report({ step: "waiting", bot: bot.id, name: bot.name, hash, why: [said(applied)] });
    await io.wait(RETRY_MS);
  }
  // What the person said yes to just now is on.
  for (const key of asks.effects) {
    const switched = await io.exchange("PUT", `/v1/agents/${bot.id}/package/effects`, {
      key,
      on: true,
    });
    if (switched.status !== 200)
      throw new CliFailure("failed", `${key} wasn't turned on: ${said(switched)}`);
  }
  state.hash = hash;
  state.applied = now.recipe;
  // A rename in bot.json renamed the same bot.
  state.bot = { id: bot.id, name };
  return { step: "updated", bot: bot.id, name, hash };
}

/** A save's problems as a step, so watching carries on. */
function refusedStep(state: State, error: CliFailure): CliBotDev {
  const problems = error.detail.problems?.map((p) => `${p.path ?? "bot.json"}: ${p.message}`);
  return {
    step: "refused",
    bot: state.bot?.id ?? "",
    name: state.bot?.name ?? "",
    hash: state.hash ?? "",
    why: problems?.length ? problems : [error.message],
  };
}

/** Installs or updates once, then on every save until `stop` aborts. */
export async function devWatch(root: string, io: DevIo, stop: AbortSignal): Promise<void> {
  const state: State = {};
  await io.report(await devStep(root, io, state));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = Promise.resolve();
  const again = () => {
    running = running.then(async () => {
      try {
        await io.report(await devStep(root, io, state));
      } catch (error) {
        if (!(error instanceof CliFailure) || error.outcome !== "failed") throw error;
        await io.report(refusedStep(state, error));
      }
    });
  };
  const watcher = watch(resolve(root), { recursive: true, signal: stop }, () => {
    clearTimeout(timer);
    timer = setTimeout(again, SETTLE_MS);
  });
  await new Promise<void>((done) => {
    if (stop.aborted) return done();
    stop.addEventListener("abort", () => done(), { once: true });
  });
  clearTimeout(timer);
  watcher.close();
  await running;
}
