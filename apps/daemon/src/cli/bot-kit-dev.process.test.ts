import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { invoke, openCli } from "../cli-test-support.ts";

/*
 * `ace bot dev` on a development Spade (ADR 0200 §9): a real `spade` on a throwaway data folder,
 * reached by its own address and token (`--spade`). The package installs once as a development
 * bot linked to the local package of its name, routines paused; each save becomes an update; a save
 * that asks for more waits for the person's yes. Spade runs with no keychain, no ace and a model
 * endpoint nothing listens on: nothing here reaches the network or a model.
 */

const program = fileURLToPath(new URL("../../../../spade/target/debug/spade", import.meta.url));
const run = existsSync(program) || process.env.CI === "true";

let root: string;
let data: string;
let spade: ChildProcess | undefined;
let api: (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: unknown }>;

/** Spade's answers, by the fields these tests read. */
const Agents = z.object({
  agents: z.array(
    z.looseObject({
      id: z.string(),
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
  data = join(root, "spade");
  await mkdir(join(root, "home"), { recursive: true });
  spade = spawn(program, [], {
    // No session bus: Spade finds no keychain and never touches the person's.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: join(root, "home"),
      SPADE_DATA_DIR: data,
      SPADE_LISTEN: "127.0.0.1:0",
      SPADE_SANDBOX: "off",
      SPADE_CLOUD_URL: "off",
      RUST_LOG: "warn",
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 20_000;
  while (!existsSync(join(data, "server.json"))) {
    if (Date.now() > deadline) throw new Error("Spade didn't start");
    await new Promise((done) => setTimeout(done, 50));
  }
  const address = JSON.parse(await readFile(join(data, "server.json"), "utf8")).address;
  const token = (await readFile(join(data, "token"), "utf8")).trim();
  api = async (method, path, body) => {
    const response = await fetch(`http://${address}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  // A model for new bots, on an address nothing listens on.
  await api("POST", "/v1/endpoints", {
    name: "Unreached",
    format: "openai-chat",
    base_url: "http://127.0.0.1:9/v1/",
  });
  await api("POST", "/v1/endpoints/unreached/models", { id: "m", name: "M" });
  await api("PUT", "/v1/settings", { new_bot_model: "unreached/m", fast_model: "unreached/m" });
}, 30_000);

afterAll(async () => {
  spade?.kill("SIGTERM");
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
