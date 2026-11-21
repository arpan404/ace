import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { invoke, openCli } from "../cli-test-support.ts";
import {
  canRunSpade,
  startThrowawaySpade,
  type SpadeApi,
  type ThrowawaySpade,
} from "./bot-kit-test-support.ts";

/*
 * `ace bot dev` on a development Spade (ADR 0200 §9): a real `spade` on a throwaway data folder
 * (`bot-kit-test-support.ts`), reached by its own address and token (`--spade`). The package installs once as a development
 * bot linked to the local package of its name, routines paused; each save becomes an update; a save
 * that asks for more waits for the person's yes; a rename keeps the same bot.
 */

const run = canRunSpade;

let root: string;
let data: string;
let spade: ThrowawaySpade | undefined;
let api: SpadeApi;

/** Spade's answers, by the fields these tests read. */
const Agents = z.object({
  agents: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string().optional(),
      task: z.string().optional(),
      package: z.looseObject({ source: z.string() }).optional(),
    }),
  ),
});
const Effects = z.object({
  package: z.looseObject({
    effects: z.array(z.object({ key: z.string(), on: z.boolean() }).loose()),
  }),
});
const agents = async () => Agents.parse((await api("GET", "/v1/agents")).body).agents;
const effects = async (bot: string) =>
  Effects.parse((await api("GET", `/v1/agents/${bot}/package`)).body).package.effects;

beforeAll(async () => {
  if (!run) return;
  root = await mkdtemp(join(tmpdir(), "ace-bot-dev-"));
  spade = await startThrowawaySpade(root);
  ({ data, api } = spade);
}, 30_000);

afterAll(async () => {
  spade?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

const manifest = (fields: Record<string, unknown> = {}) =>
  `${JSON.stringify(
    {
      format: "spade-bot",
      version: 3,
      requires: { runtime: "1" },
      name: "Fare watcher",
      blurb: "Watches fares.",
      task: "You watch fares for the person.",
      model: "fast",
      triggers: [
        { kind: "message" },
        {
          kind: "schedule",
          name: "Morning check",
          instruction: "Check every trip.",
          schedule: "daily at 7:00",
        },
      ],
      effects: [{ effect: "network", why: "Reads fares from the fare site." }],
      pricing: { kind: "free" },
      ...fields,
    },
    null,
    2,
  )}\n`;

const env = () => ({ HOME: join(root, "home"), ACE_THREAD_ID: "", ACE_NO_INPUT: "" });
const ace = (...args: string[]) => invoke(join(root, "ace"), args, "", env());

/** Reads JSON Lines from a running `ace bot dev --json` until `want` arrives. */
function lines(child: ChildProcess) {
  const seen: Record<string, unknown>[] = [];
  let buffer = "";
  child.stdout?.on("data", (bytes: Buffer) => {
    buffer += bytes.toString();
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      seen.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
    }
  });
  return async (want: (line: Record<string, unknown>) => boolean) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const found = seen.find(want);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no such line in ${JSON.stringify(seen)}`);
      await new Promise((done) => setTimeout(done, 50));
    }
  };
}

it.skipIf(!run)(
  "installs the package once as a linked development bot, then updates it on each save",
  async () => {
    const folder = join(root, "fare-watcher");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "bot.json"), manifest());

    const dev = openCli(
      join(root, "ace"),
      ["bot", "dev", folder, "--spade", data, "--yes", "--json"],
      env(),
    );
    const next = lines(dev.child);
    try {
      const installed = await next((line) => line["step"] === "installed");
      expect(installed).toMatchObject({ name: "Fare watcher" });
      const bot = String(installed["bot"]);
      const linked = await api("GET", `/v1/agents/${bot}/package`);
      expect(linked.body).toMatchObject({
        package: { source: "local", name: "local/fare-watcher", version: "local" },
      });
      expect(await effects(bot)).toMatchObject([{ key: "network", on: true }]);
      const routines = await api("GET", `/v1/agents/${bot}/routines`);
      expect(routines.body).toMatchObject({
        routines: [{ name: "Morning check", paused: true }],
      });

      // A save is an update, with no review.
      await writeFile(join(folder, "bot.json"), manifest({ task: "You watch fares and hotels." }));
      await next((line) => line["step"] === "updated");
      const updated = (await agents()).find((agent) => agent.id === bot);
      expect(updated?.task).toBe("You watch fares and hotels.");

      // A save that doesn't pass the checks isn't applied, and watching carries on.
      await writeFile(join(folder, "bot.json"), manifest({ publisher: "acme" }));
      const refused = await next((line) => line["step"] === "refused");
      expect(String((refused["why"] as string[])[0])).toMatch(/^bot\.json: publisher:/);
    } finally {
      dev.child.kill("SIGINT");
      await dev.exited;
    }
    const made = (await agents()).filter((agent) => agent.package?.source === "local");
    expect(made, "one development bot, however many saves").toHaveLength(1);
  },
  30_000,
);

it.skipIf(!run)(
  "a save that asks for more waits for the person's yes",
  async () => {
    const folder = join(root, "fare-watcher");
    await writeFile(join(folder, "bot.json"), manifest());
    const plain = await ace("bot", "dev", folder, "--spade", data, "--once", "--json");
    expect(plain.code, plain.stdout).toBe(0);
    await writeFile(
      join(folder, "bot.json"),
      manifest({
        effects: [
          { effect: "network", why: "Reads fares from the fare site." },
          { effect: "publish", why: "Posts a weekly fare report where you say." },
        ],
      }),
    );
    // No terminal to ask on and no --yes: exit 2, nothing applied.
    const asked = await ace("bot", "dev", folder, "--spade", data, "--once", "--json");
    expect(asked.code, asked.stdout).toBe(2);
    expect(JSON.parse(asked.stdout)).toMatchObject({ code: "confirm" });
    const bot = (await agents()).find((agent) => agent.package?.source === "local")?.id ?? "";
    expect((await effects(bot)).map((effect) => effect.key)).toEqual(["network"]);

    // With the person's yes it applies, and what it asked for is on.
    const yes = await ace("bot", "dev", folder, "--spade", data, "--once", "--yes", "--json");
    expect(yes.code, yes.stdout).toBe(0);
    expect(await effects(bot)).toMatchObject([
      { key: "network", on: true },
      { key: "publish", on: true },
    ]);
  },
  30_000,
);

it.skipIf(!run)(
  "renaming the bot in bot.json between runs updates the same development bot",
  async () => {
    const folder = join(root, "trips");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "bot.json"), manifest({ name: "Trip planner" }));
    const first = await ace("bot", "dev", folder, "--spade", data, "--once", "--yes", "--json");
    expect(first.code, first.stdout).toBe(0);
    const bot = String(JSON.parse(first.stdout).bot);

    await writeFile(join(folder, "bot.json"), manifest({ name: "Travel planner" }));
    const renamed = await ace("bot", "dev", folder, "--spade", data, "--once", "--yes", "--json");
    expect(renamed.code, renamed.stdout).toBe(0);
    expect(JSON.parse(renamed.stdout)).toMatchObject({
      step: "updated",
      bot,
      name: "Travel planner",
    });
    const all = await agents();
    expect(all.find((agent) => agent.id === bot)?.name).toBe("Travel planner");
    expect(
      all.filter((agent) => /planner/.test(agent.name ?? "")),
      "one bot for the folder, under its new name",
    ).toHaveLength(1);
  },
  30_000,
);

const page = (heading: string) =>
  `<!doctype html><html><head><title>Trips</title></head><body><h1>${heading}</h1><script>addEventListener("ace:state", () => {});</script></body></html>\n`;

it.skipIf(!run)(
  "a saved panel page is the page the development bot's panel shows",
  async () => {
    const folder = join(root, "panel-watcher");
    await mkdir(join(folder, "panels", "trips"), { recursive: true });
    await writeFile(
      join(folder, "bot.json"),
      manifest({
        name: "Panel watcher",
        surfaces: [{ id: "trips", kind: "panel", file: "panels/trips/index.html", title: "Trips" }],
      }),
    );
    await writeFile(join(folder, "panels", "trips", "index.html"), page("Trips"));
    const dev = openCli(
      join(root, "ace"),
      ["bot", "dev", folder, "--spade", data, "--yes", "--json"],
      env(),
    );
    const next = lines(dev.child);
    const Panels = z.object({
      panels: z.array(z.object({ id: z.string(), page: z.string().nullable() })),
    });
    const Listed = z.object({
      agents: z.array(z.looseObject({ id: z.string(), conversation: z.string() })),
    });
    try {
      const bot = String((await next((line) => line["step"] === "installed"))["bot"]);
      const listed = Listed.parse((await api("GET", "/v1/agents")).body).agents;
      const chat = listed.find((agent) => agent.id === bot)?.conversation ?? "";
      const shown = async () =>
        Panels.parse((await api("GET", `/v1/conversations/${chat}/panels`)).body).panels[0]?.page;
      const first = await shown();
      expect(first).toMatch(/^[0-9a-f]{64}$/);

      // Saving the page alone is an update that brings the new page.
      await writeFile(join(folder, "panels", "trips", "index.html"), page("Trips this week"));
      await next((line) => line["step"] === "updated");
      const second = await shown();
      expect(second).toMatch(/^[0-9a-f]{64}$/);
      expect(second).not.toBe(first);
    } finally {
      dev.child.kill("SIGINT");
      await dev.exited;
    }
  },
  30_000,
);
