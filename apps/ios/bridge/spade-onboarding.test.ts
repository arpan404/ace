import { expect, test } from "vitest";
import type { FakeSpadeApi } from "@ace/fake-daemon";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";

/*
 * First run on the iPhone, at the foot of the main Spade's chat: the model and key it answers
 * with while it has none it can use, then the About-you interview whose answers become the
 * shared notes every bot reads (spade/docs/memory.md); and the transcription model voice
 * messages need. A key goes to Spade once and is never said back.
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

const fresh = async (seed: (fake: FakeSpadeApi) => void = () => {}) => {
  const host = await setUp((fake) => {
    fake.addAgent({ id: "spade", name: "Spade", kind: "main", model: "" });
    fake.addAgent({ id: "garden", name: "Garden", model: "" });
    fake.onboarding.about_you = null;
    seed(fake);
  });
  await until(() => host.spade.ready);
  return host;
};
const conversationOf = (api: FakeSpadeApi, id: string) =>
  String(api.agents.find((agent) => agent.id === id)?.conversation);

test("a fresh Spade with no key shows the setup card, and once a key is saved the interview follows", async () => {
  const { ask, api } = await fresh((fake) => {
    fake.endpoints = [structuredClone(openrouter)];
  });
  const conversationId = conversationOf(api, "spade");

  const before = await ask({ type: "spade.onboarding.read", conversationId });
  expect(before).toMatchObject({
    ok: true,
    foot: {
      setup: {
        title: "Pick the model Spade answers with",
        picked: "endpoint:openrouter",
        options: expect.arrayContaining([
          expect.objectContaining({ value: "endpoint:openrouter", label: "OpenRouter", key: true }),
          expect.objectContaining({ value: "custom", label: "Custom or local server" }),
        ]),
      },
    },
  });

  const key = "sk-or-first-run-31";
  const saved = await ask({
    type: "spade.onboarding.model",
    conversationId,
    choice: "endpoint:openrouter",
    key,
  });

  expect(JSON.stringify(saved)).not.toContain(key);
  expect(saved).toMatchObject({ ok: true, foot: { aboutYou: { questions: expect.any(Array) } } });
  expect(api.endpoints[0]?.key_set).toBe(true);
  expect(api.agents.find((agent) => agent.id === "spade")?.model).toBe("openrouter/kimi-k2");
  // The next message goes to Spade, which now has a model to answer with.
  expect(await ask({ type: "spade.send", conversationId, text: "Hello" })).toEqual({ ok: true });
});

test("only the main Spade's chat carries the setup card", async () => {
  const { ask, api } = await fresh((fake) => {
    fake.endpoints = [structuredClone(openrouter)];
  });

  const answer = await ask({
    type: "spade.onboarding.read",
    conversationId: conversationOf(api, "garden"),
  });

  expect(answer).toEqual({ ok: true, foot: null });
});

test("a key Spade refuses in setup is said in fixed words, and the model stays unset", async () => {
  const { ask, api, daemon } = await fresh((fake) => {
    fake.endpoints = [structuredClone(openrouter)];
  });
  const key = "sk-or-leaky-55";
  daemon.spade.serve({
    answer: (request) =>
      request.path.startsWith("/v1/keys/")
        ? { status: 400, body: JSON.stringify({ error: `bad key ${key}` }) }
        : api.answer(request),
    open: (path) => api.open(path),
  });

  const answer = await ask({
    type: "spade.onboarding.model",
    conversationId: conversationOf(api, "spade"),
    choice: "endpoint:openrouter",
    key,
  });

  expect(answer).toEqual({
    ok: false,
    title: "Couldn't keep the key",
    message: "Spade didn't take that key. Check it and try again.",
  });
  expect(api.agents.find((agent) => agent.id === "spade")?.model).toBe("");
});

test("a service picked from the presets is added, keyed and answered with in one step", async () => {
  const { ask, api } = await fresh((fake) => {
    fake.presets = [
      {
        id: "moonshot",
        name: "Moonshot (OpenAI format)",
        format: "openai-chat",
        base_url: "https://api.moonshot.ai/v1",
        models: [{ id: "kimi-k2", name: "Kimi K2" }],
      },
    ];
  });

  const answer = await ask({
    type: "spade.onboarding.model",
    conversationId: conversationOf(api, "spade"),
    choice: "preset:moonshot",
    key: "sk-moon",
  });

  expect(answer).toMatchObject({ ok: true });
  expect(api.endpoints.map((each) => [each.name, each.key_set])).toEqual([["Moonshot", true]]);
  expect(api.agents.find((agent) => agent.id === "spade")?.model).toMatch(/^moonshot\/kimi-k2$/);
});

test("answers given in the phone's interview become the shared notes web shows", async () => {
  const { ask, api } = await fresh((fake) => {
    fake.endpoints = [{ ...structuredClone(openrouter), key_set: true }];
    fake.addAgent({ id: "spade", name: "Spade", kind: "main", model: "openrouter/kimi-k2" });
  });
  const conversationId = conversationOf(api, "spade");
  expect(await ask({ type: "spade.onboarding.read", conversationId })).toMatchObject({
    foot: { aboutYou: {} },
  });

  const done = await ask({
    type: "spade.onboarding.aboutYou",
    conversationId,
    answers: { name: "Rin", work: "  ", help: "Keeping my garden alive" },
  });

  expect(done).toEqual({ ok: true, foot: null });
  const notes = await api.answer({ method: "GET", path: "/v1/notes", body: undefined });
  const texts = (JSON.parse(notes.body ?? "{}") as { notes: { text: string }[] }).notes.map(
    (note) => note.text,
  );
  expect(texts.some((text) => text.includes("Rin"))).toBe(true);
  expect(texts.some((text) => text.includes("Keeping my garden alive"))).toBe(true);
  expect(texts).toHaveLength(2);
  expect(api.onboarding.about_you).toBe("done");
});

test("skipping the interview is remembered, so it never asks again", async () => {
  const { ask, api } = await fresh((fake) => {
    fake.endpoints = [{ ...structuredClone(openrouter), key_set: true }];
    fake.addAgent({ id: "spade", name: "Spade", kind: "main", model: "openrouter/kimi-k2" });
  });
  const conversationId = conversationOf(api, "spade");

  expect(await ask({ type: "spade.onboarding.aboutYou", conversationId, skip: true })).toEqual({
    ok: true,
    foot: null,
  });
  expect(api.onboarding.about_you).toBe("skipped");
  expect(await ask({ type: "spade.onboarding.read", conversationId })).toEqual({
    ok: true,
    foot: null,
  });
});

test("voice setup offers the person's models that turn speech into words, and says so when none can", async () => {
  const whisper = {
    id: "openai",
    name: "OpenAI",
    format: "openai-chat",
    base_url: "https://api.openai.com/v1",
    needs_key: true,
    key_set: true,
    key_source: "keychain",
    models: [
      { id: "gpt-5", name: "GPT-5" },
      { id: "whisper-1", name: "Whisper" },
    ],
  };
  const { ask, api } = await fresh((fake) => {
    fake.endpoints = [whisper, structuredClone(openrouter)];
  });

  const offered = await ask({ type: "spade.onboarding.voice" });
  expect(offered).toEqual({
    ok: true,
    voice: {
      needed: true,
      choices: [{ model: "openai/whisper-1", label: "Use OpenAI · Whisper" }],
      none: null,
    },
  });

  api.endpoints = [structuredClone(openrouter)];
  const none = await ask({ type: "spade.onboarding.voice" });
  expect(none).toMatchObject({
    voice: { needed: true, choices: [], none: expect.stringMatching(/^None of your endpoints/) },
  });
});
