import { expect, test } from "vitest";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";
import { spadeChoicesBudget } from "./spade-settings-rows.ts";
import { utf8Bytes } from "./spade-profile.ts";

/*
 * A new bot from the phone (ADR 0197): one message is its task and its first message, and it
 * names itself as it starts; or a template the machine ships, its first job in the message.
 */

const endpoint = {
  id: "anthropic",
  name: "Anthropic",
  format: "anthropic",
  base_url: "https://api.anthropic.com",
  needs_key: true,
  key_set: true,
  key_source: "keychain",
  models: [{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
};

test("New bot offers the machine's templates and the model new bots start on", async () => {
  const { ask, spade } = await setUp((fake) => {
    fake.endpoints = [structuredClone(endpoint)];
    fake.teams.templates = [
      { id: "research", name: "Research", blurb: "Finds and reads sources", task: "Research" },
    ];
  });
  await until(() => spade.ready);

  const answer = await ask({ type: "spade.newbot.read" });

  if (!("templates" in answer)) throw new Error(JSON.stringify(answer));
  expect(answer.templates).toEqual([
    {
      id: "research",
      name: "Research",
      blurb: "Finds and reads sources",
      face: expect.objectContaining({ main: false, initial: "R", character: expect.any(Object) }),
    },
  ]);
  expect(answer.model).toMatchObject({ value: "", words: "Claude Sonnet 4.5 · Anthropic" });
  expect(answer.groups.map((group) => group.label)).toEqual(["Anthropic"]);
});

test("a bot made from one message starts on it, names itself, and opens on its conversation", async () => {
  const { ask, api, patches, spade } = await setUp((fake) => {
    fake.endpoints = [structuredClone(endpoint)];
  });
  await until(() => spade.ready);

  const answer = await ask({
    type: "spade.newbot.create",
    text: "Watch the release branch and tell me when CI goes red",
  });

  if (!("conversation" in answer)) throw new Error(JSON.stringify(answer));
  const made = api.agents.find((agent) => agent.id === answer.agentId);
  expect(made).toMatchObject({
    name: "New bot",
    task: "Watch the release branch and tell me when CI goes red",
    conversation: answer.conversation,
  });
  const sent = JSON.parse(
    api.requests.find((r) => r.method === "POST" && r.path === "/v1/agents")?.body ?? "{}",
  );
  expect(sent).toMatchObject({
    naming: true,
    first_message: { text: "Watch the release branch and tell me when CI goes red" },
  });
  // The list shows it at once, so its conversation is named.
  await until(() => patches.state?.list.rows?.some((row) => row.id === answer.agentId) === true);
});

test("from a template the bot takes its name, kept apart from a bot that has it, and its first job", async () => {
  const { ask, api, patches, spade } = await setUp((fake) => {
    fake.endpoints = [structuredClone(endpoint)];
    fake.addAgent({ id: "old", name: "Research" });
    fake.teams.templates = [{ id: "research", name: "Research", blurb: "", task: "Research" }];
  });
  await until(() => spade.ready);
  await until(() => patches.state?.list.rows?.some((row) => row.id === "old") === true);

  const answer = await ask({
    type: "spade.newbot.create",
    text: "Start with the Swift 6 migration notes",
    template: "research",
    model: "anthropic/claude-sonnet-4-5",
    timeZone: "Europe/Lisbon",
  });

  if (!("conversation" in answer)) throw new Error(JSON.stringify(answer));
  const sent = JSON.parse(
    api.requests.findLast((r) => r.path === "/v1/agents" && r.method === "POST")?.body ?? "{}",
  );
  expect(sent).toMatchObject({
    name: "Research 2",
    template: "research",
    model: "anthropic/claude-sonnet-4-5",
    time_zone: "Europe/Lisbon",
    first_message: { text: "Start with the Swift 6 migration notes" },
  });
  expect(sent.naming).toBeUndefined();
});

test("a bot Spade won't make says why in its words", async () => {
  const { ask, api, daemon, spade } = await setUp();
  await until(() => spade.ready);
  daemon.spade.serve({
    answer: (request) =>
      request.method === "POST" && request.path === "/v1/agents"
        ? { status: 400, body: JSON.stringify({ error: "Add a model first." }) }
        : api.answer(request),
    open: (path) => api.open(path),
  });

  const answer = await ask({ type: "spade.newbot.create", text: "Do things" });

  expect(answer).toMatchObject({
    ok: false,
    title: "Couldn't make the bot",
    message: "Add a model first.",
  });
});

test("hundreds of models still fit in one frame, saying how many were left out", async () => {
  const many = Array.from({ length: 900 }, (_, at) => ({
    id: `vendor/model-with-a-long-name-${at}`,
    name: `A model with a fairly long display name, number ${at}`,
  }));
  const { ask, spade } = await setUp((fake) => {
    fake.endpoints = [
      { ...structuredClone(endpoint), id: "big", name: "Big router", models: many },
    ];
  });
  await until(() => spade.ready);

  const answer = await ask({ type: "spade.newbot.read" });

  if (!("groups" in answer)) throw new Error(JSON.stringify(answer));
  expect(utf8Bytes(JSON.stringify(answer))).toBeLessThanOrEqual(spadeChoicesBudget + 2_000);
  const shown = answer.groups.reduce((sum, group) => sum + group.choices.length, 0);
  expect(shown).toBeGreaterThan(50);
  expect(answer.more).toBe(900 - shown);
});
