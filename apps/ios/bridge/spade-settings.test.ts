import { expect, test } from "vitest";
import type { FakeSpadeApi } from "@ace/fake-daemon";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";

/*
 * Settings › Spade on the iPhone: General (Spade on or off, and the models it uses), Models and
 * keys (each endpoint and its key, ADR 0119), Web search and Apps, each read from Spade and
 * written back. A key the person types goes to Spade once and never comes back.
 */

const anthropic = {
  id: "anthropic",
  name: "Anthropic",
  format: "anthropic",
  base_url: "https://api.anthropic.com",
  needs_key: true,
  key_set: true,
  key_source: "keychain",
  models: [
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
};
const openrouter = {
  id: "openrouter",
  name: "OpenRouter",
  format: "openai-chat",
  base_url: "https://openrouter.ai/api/v1",
  needs_key: true,
  key_set: false,
  key_source: null,
  models: [{ id: "kimi-k2", name: "Kimi K2" }],
};

const ready = async (seed: (fake: FakeSpadeApi) => void = () => {}) => {
  const host = await setUp((fake) => {
    fake.endpoints = [structuredClone(anthropic), structuredClone(openrouter)];
    seed(fake);
  });
  await until(() => host.spade.ready);
  return host;
};

test("General says Spade runs here and offers every endpoint's models for each of its models", async () => {
  const { ask } = await ready((fake) => {
    fake.fastModel = "anthropic/claude-haiku-4-5";
  });

  const answer = await ask({ type: "spade.settings.read", page: "general" });

  if (!("general" in answer)) throw new Error(JSON.stringify(answer));
  expect(answer.general.run.on).toBe(true);
  expect(answer.general.models.map((row) => [row.role, row.value, row.words])).toEqual([
    // No model chosen for new bots: they start on the first usable one, which it names.
    ["new_bot", "", "Claude Sonnet 4.5 · Anthropic"],
    ["fast", "anthropic/claude-haiku-4-5", "Claude Haiku 4.5 · Anthropic"],
    ["transcription", "", "Off"],
    ["speech", "", "System voices"],
  ]);
  expect(answer.general.groups).toEqual([
    {
      label: "Anthropic",
      choices: [
        { value: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { value: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5" },
      ],
    },
    { label: "OpenRouter", choices: [{ value: "openrouter/kimi-k2", name: "Kimi K2" }] },
  ]);
});

test("a model chosen on the phone is the one Spade keeps, and clearing it goes back to the default", async () => {
  const { ask, api } = await ready();

  const chosen = await ask({
    type: "spade.settings.model",
    role: "new_bot",
    model: "openrouter/kimi-k2",
  });
  expect(api.newBotModel).toBe("openrouter/kimi-k2");
  if (!("general" in chosen)) throw new Error(JSON.stringify(chosen));
  expect(chosen.general.models[0]).toMatchObject({
    value: "openrouter/kimi-k2",
    words: "Kimi K2 · OpenRouter",
  });

  await ask({ type: "spade.settings.model", role: "new_bot", model: null });
  expect(api.newBotModel).toBeNull();
});

test("a model Spade refuses says why in its words and keeps what was saved", async () => {
  const { ask, api } = await ready();

  const answer = await ask({ type: "spade.settings.model", role: "speech", model: "gone/voice" });

  expect(answer).toMatchObject({
    ok: false,
    message: "The speech model must be on one of your endpoints.",
  });
  expect(api.speechModel).toBeNull();
});

test("Models and keys lists each endpoint with where its key is, and never a key's value", async () => {
  const { ask } = await ready((fake) => {
    fake.endpoints.push({
      id: "local",
      name: "Local server",
      format: "openai-chat",
      base_url: "http://localhost:11434/v1",
      needs_key: false,
      key_set: false,
      models: [],
    });
  });

  const answer = await ask({ type: "spade.settings.read", page: "models" });

  if (!("models" in answer)) throw new Error(JSON.stringify(answer));
  expect(answer.models.endpoints.map((row) => [row.name, row.address, row.key])).toEqual([
    [
      "Anthropic",
      "api.anthropic.com",
      { words: "In keychain", set: true, canSet: true, canRemove: true },
    ],
    [
      "OpenRouter",
      "openrouter.ai",
      { words: "Not set", set: false, canSet: true, canRemove: false },
    ],
    [
      "Local server",
      "localhost:11434",
      { words: "Not needed", set: false, canSet: false, canRemove: false },
    ],
  ]);
  expect(answer.models.endpoints[0]?.models).toEqual(["Claude Sonnet 4.5", "Claude Haiku 4.5"]);
});

test("a key typed on the phone goes to Spade's keychain once, and its value is never answered back", async () => {
  const { ask, api } = await ready();
  const key = "sk-or-very-secret-1234";

  const answer = await ask({ type: "spade.settings.key", endpoint: "openrouter", key });

  if (!("models" in answer)) throw new Error(JSON.stringify(answer));
  expect(answer.models.endpoints[1]?.key).toMatchObject({ set: true, canRemove: true });
  expect(JSON.stringify(answer)).not.toContain(key);
  const sent = api.requests.filter((request) => request.body?.includes(key));
  expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
    "PUT /v1/keys/openrouter",
  ]);

  const removed = await ask({ type: "spade.settings.key", endpoint: "openrouter", key: null });
  if (!("models" in removed)) throw new Error(JSON.stringify(removed));
  expect(removed.models.endpoints[1]?.key).toMatchObject({ set: false, words: "Not set" });
});

test("on a machine with no keychain a key can't be set here, and the page says to use the environment", async () => {
  const { ask } = await ready((fake) => {
    fake.keychain = false;
    fake.endpoints[1] = {
      ...structuredClone(openrouter),
      key_set: true,
      key_source: "environment",
    };
  });

  const answer = await ask({ type: "spade.settings.read", page: "models" });

  if (!("models" in answer)) throw new Error(JSON.stringify(answer));
  expect(answer.models.keychain).toBe(false);
  expect(answer.models.note).toMatch(/environment/);
  expect(answer.models.endpoints[1]?.key).toEqual({
    words: "From environment",
    set: true,
    canSet: false,
    canRemove: false,
  });
});

test("an endpoint added from a preset shows with its models, and one a bot uses can't be removed", async () => {
  const { ask, api } = await ready((fake) => {
    fake.presets = [
      {
        id: "anthropic",
        name: "Anthropic",
        format: "anthropic",
        base_url: "https://api.anthropic.com",
      },
      {
        id: "moonshot",
        name: "Moonshot (OpenAI format)",
        format: "openai-chat",
        base_url: "https://api.moonshot.ai/v1",
        models: [{ id: "kimi-k2", name: "Kimi K2" }],
      },
    ];
    fake.addAgent({ id: "writer", name: "Writer", model: "anthropic/claude-sonnet-4-5" });
  });

  const read = await ask({ type: "spade.settings.read", page: "models" });
  if (!("models" in read)) throw new Error(JSON.stringify(read));
  // Anthropic is added already; Moonshot is offered by its plain name.
  expect(read.models.presets).toEqual([{ id: "moonshot", name: "Moonshot" }]);

  const added = await ask({ type: "spade.settings.endpoint.add", preset: "moonshot" });
  if (!("models" in added)) throw new Error(JSON.stringify(added));
  expect(added.models.endpoints.at(-1)).toMatchObject({ name: "Moonshot", models: ["Kimi K2"] });
  expect(added.models.presets).toEqual([]);

  const refused = await ask({ type: "spade.settings.endpoint.remove", endpoint: "anthropic" });
  expect(refused).toMatchObject({ ok: false, message: "Writer use this endpoint." });
  expect(api.endpoints.some((endpoint) => endpoint.id === "anthropic")).toBe(true);
});

test("Web search keeps the person's SearXNG address and a Brave key, which never comes back", async () => {
  const { ask, api } = await ready();

  const searx = await ask({ type: "spade.settings.searxng", url: "https://search.example.org" });
  if (!("search" in searx)) throw new Error(JSON.stringify(searx));
  expect(searx.search.searxng).toBe("https://search.example.org/");

  const wrong = await ask({ type: "spade.settings.searxng", url: "search.example.org" });
  expect(wrong).toMatchObject({
    ok: false,
    message: "the SearXNG address must start with http:// or https://",
  });

  const brave = await ask({ type: "spade.settings.brave", key: "brave-secret-9" });
  if (!("search" in brave)) throw new Error(JSON.stringify(brave));
  expect(brave.search.brave).toEqual({
    set: true,
    words: "In keychain",
    canSet: true,
  });
  expect(JSON.stringify(brave)).not.toContain("brave-secret-9");
  expect(api.search.braveKeySet).toBe(true);

  const forgot = await ask({ type: "spade.settings.searxng", url: null });
  if (!("search" in forgot)) throw new Error(JSON.stringify(forgot));
  expect(forgot.search.searxng).toBeNull();
});

test("Apps lists each connected app with its health and the bots that use it, and disconnects one", async () => {
  const { ask, api } = await ready((fake) => {
    fake.addAgent({ id: "spade", name: "Spade", kind: "main" });
    fake.addAgent({ id: "writer", name: "Writer" });
    fake.connectors.connectors = [
      {
        id: "github",
        name: "GitHub",
        url: "https://api.github.com/mcp",
        state: "connected",
        account: "ace-dev",
        tools: 3,
      },
      {
        id: "linear",
        name: "Linear",
        url: "https://mcp.linear.app",
        state: "needs_reconnect",
        tools: 0,
      },
    ];
    fake.connectors.access.set("writer", { all: false, connectors: ["github"] });
    fake.skillStore = {
      ace: false,
      skills: [
        { id: "s1", name: "Release notes", origin: "spade", written_by: ["writer"] },
        { id: "s2", name: "Unused", origin: "ace" },
      ],
    };
  });

  const answer = await ask({ type: "spade.settings.read", page: "apps" });

  if (!("apps" in answer)) throw new Error(JSON.stringify(answer));
  expect(answer.apps.apps).toEqual([
    {
      id: "github",
      name: "GitHub",
      health: "Working",
      ok: true,
      account: "ace-dev",
      line: "Spade, Writer · Not used yet",
    },
    {
      id: "linear",
      name: "Linear",
      health: "Needs reconnect",
      ok: false,
      account: null,
      line: "Spade · Not used yet",
    },
  ]);
  // A skill shows once a bot uses or wrote it.
  expect(answer.apps.skills).toEqual([{ name: "Release notes", line: "Written by Writer" }]);

  const after = await ask({ type: "spade.settings.disconnect", connector: "linear" });
  if (!("apps" in after)) throw new Error(JSON.stringify(after));
  expect(after.apps.apps.map((app) => app.id)).toEqual(["github"]);
  expect(api.connectors.connectors.map((app) => app.id)).toEqual(["github"]);
});

test("while Spade is off, General offers to turn it on and the other pages read nothing from it", async () => {
  const { ask, api, daemon, spade } = await setUp((fake, machine) => {
    machine.services.settings.write("spade.enabled", false);
    machine.spade.status = { state: "off" };
    fake.endpoints = [structuredClone(anthropic)];
  });
  await until(() => spade.setting.enabled === false);

  const general = await ask({ type: "spade.settings.read", page: "general" });
  const models = await ask({ type: "spade.settings.read", page: "models" });

  expect(general).toMatchObject({ ok: true, general: { run: { on: false }, models: [] } });
  expect(models).toMatchObject({ ok: true, line: { ready: false, canTurnOn: true } });
  expect("models" in models).toBe(false);
  expect(api.requests.some((request) => request.path === "/v1/models")).toBe(false);

  const on = await ask({ type: "spade.settings.run", on: true });
  expect(on).toMatchObject({ ok: true });
  expect(daemon.services.settings.get("spade.enabled")).toBe(true);
});
