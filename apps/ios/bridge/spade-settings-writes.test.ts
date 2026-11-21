import { expect, test } from "vitest";
import type { FakeDaemon, FakeSpadeApi, FakeSpadeRequest } from "@ace/fake-daemon";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";

/*
 * Settings › Spade's writes when something goes wrong: a key's failure never carries Spade's own
 * words (they could echo the key), a write that went through says so even when the page can't
 * be read again, a Brave key says where it comes from, and an app whose sign-in ended can be
 * reconnected from the phone, or the phone says plainly where it can be.
 */

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
    fake.endpoints = [structuredClone(openrouter)];
    seed(fake);
  });
  await until(() => host.spade.ready);
  return host;
};

/** Spade answers `answer` for the requests `matches` picks, and as before for the rest. */
function stage(
  daemon: FakeDaemon,
  api: FakeSpadeApi,
  matches: (request: FakeSpadeRequest) => boolean,
  answer: { status: number; body: string },
) {
  daemon.spade.serve({
    answer: (request) => {
      if (!matches(request)) return api.answer(request);
      api.requests.push(request);
      return answer;
    },
    open: (path) => api.open(path),
  });
}

const echo = (text: string) => JSON.stringify({ error: `invalid key: ${text}` });

test("a key Spade refuses is said in fixed words, never in Spade's, which could echo the key", async () => {
  const { ask, api, daemon } = await ready();
  const key = "sk-or-leaky-secret-77";
  stage(daemon, api, (r) => r.path.startsWith("/v1/keys/"), { status: 400, body: echo(key) });

  const kept = await ask({ type: "spade.settings.key", endpoint: "openrouter", key });
  const removed = await ask({ type: "spade.settings.key", endpoint: "openrouter", key: null });

  expect(kept).toEqual({
    ok: false,
    title: "Couldn't keep the key",
    message: "Spade didn't take that key. Check it and try again.",
  });
  expect(removed).toMatchObject({ ok: false, title: "Couldn't remove the key" });
  expect(JSON.stringify([kept, removed])).not.toContain(key);
});

test("a Brave key refused for want of a keychain says so, in fixed words", async () => {
  const { ask, api, daemon } = await ready();
  const key = "brave-leaky-secret";
  stage(daemon, api, (r) => r.path === "/v1/search/brave-key", { status: 503, body: echo(key) });

  const answer = await ask({ type: "spade.settings.brave", key });

  expect(answer).toEqual({
    ok: false,
    title: "Couldn't keep the key",
    message: "This machine has no keychain to keep keys in.",
  });
});

test("a key kept while the page can't be read again says it was saved, so it isn't pasted twice", async () => {
  const { ask, api, daemon } = await ready();
  stage(daemon, api, (r) => r.method === "GET" && r.path === "/v1/models", {
    status: 500,
    body: "{}",
  });

  const answer = await ask({ type: "spade.settings.key", endpoint: "openrouter", key: "sk-or-1" });

  expect(answer).toMatchObject({
    ok: true,
    notice: "Saved. The page couldn't be read again; pull to refresh.",
  });
  expect("models" in answer).toBe(false);
  expect(api.endpoints[0]?.key_set).toBe(true);
});

test("a Brave key from the environment says so, and only a keychain key offers Remove", async () => {
  const { ask } = await ready((fake) => {
    fake.search.braveEnv = true;
  });

  const fromEnv = await ask({ type: "spade.settings.read", page: "search" });
  if (!("search" in fromEnv)) throw new Error(JSON.stringify(fromEnv));
  expect(fromEnv.search.brave).toEqual({
    set: true,
    words: "From environment",
    canSet: true,
    canRemove: false,
  });

  const kept = await ask({ type: "spade.settings.brave", key: "brave-1" });
  if (!("search" in kept)) throw new Error(JSON.stringify(kept));
  expect(kept.search.brave).toEqual({
    set: true,
    words: "In keychain",
    canSet: true,
    canRemove: true,
  });
});

const apps = (fake: FakeSpadeApi) => {
  fake.addAgent({ id: "spade", name: "Spade", kind: "main" });
  fake.connectors.catalogue = [
    { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/" },
    { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp" },
  ];
  fake.connectors.deviceSignIn.add("github");
  fake.connectors.connectors = [
    {
      id: "github",
      name: "GitHub",
      url: "https://api.githubcopilot.com/mcp/",
      catalogue: "github",
      sign_in: "oauth",
      state: "needs_reconnect",
      tools: 0,
    },
    {
      id: "linear",
      name: "Linear",
      url: "https://mcp.linear.app/mcp",
      catalogue: "linear",
      sign_in: "oauth",
      state: "needs_reconnect",
      tools: 0,
    },
    {
      id: "notion",
      name: "Notion",
      url: "https://mcp.notion.com/mcp",
      sign_in: "token",
      state: "needs_reconnect",
      tools: 0,
    },
    {
      id: "slack",
      name: "Slack",
      url: "https://mcp.slack.com/mcp",
      sign_in: "oauth",
      state: "connected",
      tools: 4,
    },
  ];
};

test("each app whose sign-in ended offers Reconnect: by token on the phone, or by signing in", async () => {
  const { ask } = await ready(apps);

  const answer = await ask({ type: "spade.settings.read", page: "apps" });

  if (!("apps" in answer)) throw new Error(JSON.stringify(answer));
  expect(answer.apps.apps.map((app) => [app.id, app.reconnect])).toEqual([
    ["github", "sign_in"],
    ["linear", "sign_in"],
    ["notion", "token"],
    ["slack", null],
  ]);
});

test("a device sign-in shows its code and the page to enter it on, which the phone can open", async () => {
  const { ask } = await ready(apps);

  const answer = await ask({ type: "spade.settings.reconnect", connector: "github" });

  if (!("apps" in answer)) throw new Error(JSON.stringify(answer));
  const github = answer.apps.apps.find((app) => app.id === "github");
  expect(github?.device).toEqual({ code: "WDJB-MJH1", url: "https://github.com/login/device" });
  expect(github?.health).toBe("Enter WDJB-MJH1 on GitHub's page to finish signing in.");
});

test("a sign-in that needs the computer's browser says so plainly", async () => {
  const { ask } = await ready(apps);

  const answer = await ask({ type: "spade.settings.reconnect", connector: "linear" });

  expect(answer).toMatchObject({
    ok: true,
    notice:
      "Linear signs in through a browser on Fake machine. Finish there, in Settings › Spade › Apps.",
  });
});

test("a token app reconnects with a token pasted on the phone, which never comes back", async () => {
  const { ask, api } = await ready(apps);

  const answer = await ask({
    type: "spade.settings.reconnect",
    connector: "notion",
    token: "secret_notion_9",
  });

  if (!("apps" in answer)) throw new Error(JSON.stringify(answer));
  expect(answer.apps.apps.find((app) => app.id === "notion")).toMatchObject({
    ok: true,
    reconnect: null,
  });
  expect(JSON.stringify(answer)).not.toContain("secret_notion_9");
  expect(api.connectors.connectors.find((app) => app.id === "notion")?.state).toBe("connected");
});

test("a refused token is said in fixed words", async () => {
  const { ask, api, daemon } = await ready(apps);
  stage(daemon, api, (r) => r.path.endsWith("/connect"), {
    status: 400,
    body: echo("secret_notion_9"),
  });

  const answer = await ask({
    type: "spade.settings.reconnect",
    connector: "notion",
    token: "secret_notion_9",
  });

  expect(answer).toEqual({
    ok: false,
    title: "Couldn't reconnect Notion",
    message: "Notion didn't take that token. Check it and try again.",
  });
});
