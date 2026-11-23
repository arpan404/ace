import { expect, test } from "vitest";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";

/*
 * A packaged bot's line above its task on the iPhone, its declared effects' switches and a
 * template bot's update review, against the fake Spade and the fake daemon's Marketplace.
 */

const effects = [
  {
    key: "network",
    effect: "network",
    hosts: ["api.example-fares.com"],
    why: "Reads fares.",
    on: true,
  },
  { key: "pay", effect: "pay", hosts: [], why: "Books the flight.", on: false },
];

async function withBot(link: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  const host = await setUp((fake, daemon) => {
    fake.addAgent({ id: "flights", name: "Flight watcher", package: link, ...extra });
    daemon.marketplace.seed({
      installed: [
        {
          source: "market",
          type: "spade-bot",
          name: "flight-watcher",
          title: "Flight watcher",
          version: "1.0.0",
          hash: "c".repeat(64),
          acceptedAt: 1,
          state: "on",
          target: "flights",
          linked: true,
          update: "1.1.0",
        },
      ],
    });
  });
  await until(() => host.patches.state?.list.rows?.some((row) => row.id === "flights") === true);
  const line = async () => {
    const answer = await host.ask({ type: "spade.package", agentId: "flights" });
    if (!("package" in answer)) throw new Error(JSON.stringify(answer));
    return answer.package;
  };
  return { ...host, line };
}

const marketLink = {
  source: "market",
  name: "flight-watcher",
  version: "1.0.0",
  hash: "c".repeat(64),
  previous: { version: "0.9.0" },
  effects,
};

test("a bot from a package says where it came from, with Update and Roll back", async () => {
  const { line } = await withBot(marketLink);

  expect(await line()).toMatchObject({
    sentence: "From flight-watcher 1.0.0 in the Marketplace.",
    name: "flight-watcher",
    update: "1.1.0",
    rollBack: "0.9.0",
    withdrawn: false,
    template: null,
    effects: [
      {
        key: "network",
        words: "Reaches api.example-fares.com",
        why: "Reads fares.",
        on: true,
        eachTime: false,
      },
      { key: "pay", words: "Can ask you to pay", on: false, eachTime: true },
    ],
  });
});

test("a withdrawn version says so and offers no update; one updating offers nothing", async () => {
  const withdrawn = await withBot({ ...marketLink, withdrawn: { reason: "It leaked keys." } });
  expect(await withdrawn.line()).toMatchObject({
    sentence: "Paused: flight-watcher 1.0.0 was withdrawn. It leaked keys.",
    withdrawn: true,
    update: null,
    rollBack: "0.9.0",
  });
});

test("a bot mid-update offers neither Update nor Roll back", async () => {
  const { line } = await withBot({ ...marketLink, updating: "1.1.0" });
  expect(await line()).toMatchObject({
    sentence: "Updating from flight-watcher 1.0.0 to 1.1.0.",
    update: null,
    rollBack: null,
  });
});

test("a bot that isn't from a package has no line", async () => {
  const { line } = await withBot(null);
  expect(await line()).toBeNull();
});

test("turning a declared effect off narrows the bot's package, on grants it again, and nothing undeclared turns on", async () => {
  const { ask, api, line } = await withBot(marketLink);
  const stored = () => {
    const link = api.agents.find((agent) => agent.id === "flights")?.package;
    return (link?.["effects"] ?? []) as { key: string; on: boolean }[];
  };

  expect(
    await ask({
      type: "spade.package.effect",
      agentId: "flights",
      key: "network",
      on: false,
      hash: "c".repeat(64),
    }),
  ).toEqual({
    ok: true,
  });
  expect(stored().find((each) => each.key === "network")?.on).toBe(false);
  expect((await line())?.effects[0]).toMatchObject({ key: "network", on: false });

  await ask({
    type: "spade.package.effect",
    agentId: "flights",
    key: "network",
    on: true,
    hash: "c".repeat(64),
  });
  expect(stored().find((each) => each.key === "network")?.on).toBe(true);

  const refused = await ask({
    type: "spade.package.effect",
    agentId: "flights",
    key: "camera",
    on: true,
    hash: "c".repeat(64),
  });
  expect(refused).toMatchObject({ ok: false, title: "Couldn't turn it on" });
});

test("a template bot's update is reviewed in words, keeps the person's edits and moves only when taken", async () => {
  const offered = { source: "spade", name: "inbox", version: "1.0.0", hash: "b".repeat(64) };
  const { ask, api, line } = await withBot(
    {
      source: "spade",
      name: "inbox",
      version: "0.9.0",
      hash: "a".repeat(64),
      template_update: { version: "1.0.0" },
      effects: [{ key: "network", effect: "network", hosts: [], why: "Sorts mail.", on: true }],
    },
    {
      templateOffer: {
        package: offered,
        recipe: {},
        plan: {
          name: "kept",
          task: "replace",
          face: "same",
          personality: "same",
          routines: [],
          notes_kept: 0,
          asks_more: ["send_as_person"],
          off: [],
        },
        effects: [
          { key: "network", effect: "network", hosts: [], why: "Sorts mail.", on: true },
          { key: "send_as_person", effect: "send_as_person", hosts: [], why: "Sends.", on: false },
        ],
      },
    },
  );
  expect(await line()).toMatchObject({
    sentence: "From ace's inbox template 0.9.0.",
    template: "1.0.0",
    update: null,
    rollBack: null,
  });

  const review = await ask({ type: "spade.template", agentId: "flights" });
  if (!("offer" in review)) throw new Error(JSON.stringify(review));
  expect(review.offer).toMatchObject({
    version: "1.0.0",
    changes: ["Its task changes to the new one."],
    kept: ["You renamed it, so it keeps its name."],
    more: ["Can ask you to send things in your name. Off until you turn it on."],
    effects: [
      { words: expect.stringMatching(/Changes things outside/), why: "Sorts mail." },
      { words: "Can ask you to send things in your name", why: "Sends." },
    ],
  });
  const stored = () => api.agents.find((agent) => agent.id === "flights")?.package;
  expect(stored()?.["version"]).toBe("0.9.0");

  expect(
    await ask({ type: "spade.template.take", agentId: "flights", package: review.offer.identity }),
  ).toEqual({
    ok: true,
  });
  expect(stored()).toMatchObject({ version: "1.0.0", hash: offered.hash });
  expect(await line()).toMatchObject({
    sentence: "From ace's inbox template 1.0.0.",
    template: null,
  });
});

test("a switch read on a version the bot no longer has is refused and changes nothing", async () => {
  const { ask, api } = await withBot(marketLink);
  const pay = () => {
    const link = api.agents.find((agent) => agent.id === "flights")?.package;
    const effects = (link?.["effects"] ?? []) as { key: string; on: boolean }[];
    return effects.find((each) => each.key === "pay")?.on;
  };

  const refused = await ask({
    type: "spade.package.effect",
    agentId: "flights",
    key: "pay",
    on: true,
    hash: "d".repeat(64),
  });

  expect(refused).toMatchObject({ ok: false, title: "Couldn't turn it on" });
  expect((refused as { message: string }).message).toMatch(/changed since you read it/);
  expect(pay()).toBe(false);
});

test("a tool grant's argument limits travel with its switch", async () => {
  const { line } = await withBot({
    ...marketLink,
    effects: [
      {
        key: "network:tool:deploy",
        effect: "network",
        hosts: [],
        grant: { kind: "tool", tool: "deploy", arguments: { env: "staging", ref: "main" } },
        why: "Ships the build.",
        on: false,
      },
    ],
  });

  expect((await line())?.effects).toMatchObject([
    {
      words: "Uses deploy without asking",
      limits: ["env matching staging", "ref matching main"],
    },
  ]);
  expect((await line())?.hash).toBe("c".repeat(64));
});

test("a template update whose effects can't all be read offers nothing to take", async () => {
  const { ask } = await withBot(
    { source: "spade", name: "inbox", version: "0.9.0", hash: "a".repeat(64), effects: [] },
    {
      templateOffer: {
        package: { source: "spade", name: "inbox", version: "1.0.0", hash: "b".repeat(64) },
        recipe: {},
        plan: {
          name: "same",
          task: "same",
          face: "same",
          personality: "same",
          routines: [],
          notes_kept: 0,
          asks_more: [],
          off: [],
        },
        effects: [
          { key: "publish", effect: "publish", why: "Posts.", on: false },
          { key: "x".repeat(3000), effect: "network", why: "Unreadable.", on: false },
        ],
      },
    },
  );

  const review = await ask({ type: "spade.template", agentId: "flights" });

  expect(review).toMatchObject({ ok: false, title: "Couldn't read the update" });
  expect("offer" in review).toBe(false);
});

test("a template update names what it stops asking for and what it now asks for otherwise", async () => {
  const tool = (env: string) => ({
    key: "network:tool:deploy",
    effect: "network",
    hosts: [],
    grant: { kind: "tool", tool: "deploy", arguments: { env } },
    why: "Ships.",
    on: true,
  });
  const { ask } = await withBot(
    {
      source: "spade",
      name: "inbox",
      version: "0.9.0",
      hash: "a".repeat(64),
      template_update: { version: "1.0.0" },
      effects: [
        tool("staging"),
        { key: "publish", effect: "publish", hosts: [], why: "Posts.", on: true },
      ],
    },
    {
      templateOffer: {
        package: { source: "spade", name: "inbox", version: "1.0.0", hash: "b".repeat(64) },
        recipe: {},
        plan: {
          name: "same",
          task: "same",
          face: "same",
          personality: "same",
          routines: [],
          notes_kept: 0,
          asks_more: [],
          off: ["publish"],
        },
        effects: [tool("*")],
      },
    },
  );

  const review = await ask({ type: "spade.template", agentId: "flights" });

  if (!("offer" in review)) throw new Error(JSON.stringify(review));
  expect(review.offer.changes).toEqual([
    "No longer asks for this, so it's turned off: Publishes and posts.",
    "Changes what it asks for: Uses deploy without asking, env matching *. Before: Uses deploy without asking, env matching staging.",
  ]);
  expect(review.offer.effects).toMatchObject([{ limits: ["env matching *"] }]);
});
