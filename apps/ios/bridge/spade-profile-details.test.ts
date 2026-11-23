import { expect, test } from "vitest";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";
import type { SpadeDetailsRow, SpadeRolesRow } from "./spade-requests-profile-details.ts";
import type { SpadeCheckpointRow, SpadeNetworkRow } from "./spade-profile-details.ts";

/*
 * What the person edits on a bot's profile on the iPhone, over the real SDK, a fake daemon and a
 * fake Spade: personality, the models for its other work, notifications, network rules and
 * checkpoints, each written back and read as Spade keeps it; and its spending.
 */

function partOf<T>(answer: unknown): T {
  if (typeof answer !== "object" || answer === null || !("part" in answer))
    throw new Error(JSON.stringify(answer));
  return answer.part as T;
}

async function writer(seed: Parameters<typeof setUp>[0] = () => {}) {
  const host = await setUp((fake, daemon) => {
    fake.addAgent({
      id: "writer",
      name: "Writer",
      model: "anthropic/claude-sonnet-4-5",
      spending: { today_micros: 120_000, month_micros: 4_200_000 },
    });
    seed(fake, daemon);
  });
  await until(() => host.patches.state?.list.rows?.some((row) => row.id === "writer") === true);
  return host;
}

test("personality starts quiet and saves each change for the bot's next turn", async () => {
  const { ask, api } = await writer();
  const before = partOf<SpadeDetailsRow>(await ask({ type: "spade.details", agentId: "writer" }));
  expect(before.personality).toMatchObject({ tone: null, humour: false, emoji: false });
  expect(before.spending).toEqual({
    month: expect.stringMatching(/4\.20/),
    today: expect.any(String),
  });

  const saved = partOf<SpadeDetailsRow["personality"]>(
    await ask({
      type: "spade.personality",
      agentId: "writer",
      tone: "warm",
      humour: true,
      emoji: false,
    }),
  );

  expect(saved).toMatchObject({ tone: "warm", humour: true, emoji: false });
  expect(api.agents.find((agent) => agent.id === "writer")?.personality).toEqual({
    tone: "warm",
    humour: true,
    emoji: false,
  });
});

test("a role set on the bot shows as its own, and Follow Settings puts it back", async () => {
  const { ask } = await writer((fake) => {
    fake.roles.spend.set("writer", { helper: 420_000 });
    fake.endpoints = [
      {
        id: "anthropic",
        name: "Anthropic",
        format: "anthropic",
        base_url: "https://api.anthropic.com",
        needs_key: true,
        key_set: true,
        key_source: "keychain",
        models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }],
      },
    ];
  });
  const roles = partOf<SpadeRolesRow>(await ask({ type: "spade.roles", agentId: "writer" }));
  const helper = roles.roles.find((row) => row.role === "helper");
  expect(helper).toMatchObject({ title: "Helpers", follows: true, value: "" });
  expect(helper?.spent).toMatch(/0\.42 this month/);
  expect(roles.roles.map((row) => row.role)).toEqual([
    "helper",
    "verify",
    "review",
    "compact",
    "title",
  ]);
  const choice = roles.groups
    .flatMap((group) => group.choices)
    .find((each) => /haiku/.test(each.value))?.value;
  if (!choice) throw new Error("no model to choose");

  const set = partOf<SpadeRolesRow>(
    await ask({ type: "spade.role", agentId: "writer", role: "helper", model: choice }),
  );
  expect(set.roles.find((row) => row.role === "helper")).toMatchObject({
    follows: false,
    value: choice,
    words: expect.stringMatching(/Haiku/),
  });

  const back = partOf<SpadeRolesRow>(
    await ask({ type: "spade.role", agentId: "writer", role: "helper", model: "" }),
  );
  expect(back.roles.find((row) => row.role === "helper")).toMatchObject({ follows: true });
});

test("notifications turn off for one bot, and its approvals can wait through quiet hours", async () => {
  const { ask } = await writer();
  const off = partOf<SpadeDetailsRow["reach"]>(
    await ask({ type: "spade.reach", agentId: "writer", notify: false }),
  );
  expect(off).toEqual({ notify: false, approvals: "inherit" });

  const waits = partOf<SpadeDetailsRow["reach"]>(
    await ask({ type: "spade.reach", agentId: "writer", notify: true, approvals: "wait" }),
  );
  expect(waits).toEqual({ notify: true, approvals: "wait" });
  const read = partOf<SpadeDetailsRow>(await ask({ type: "spade.details", agentId: "writer" }));
  expect(read.reach).toEqual({ notify: true, approvals: "wait" });
});

test("a network rule saves its mode and sites, a default can be dropped, and the machine's comes back", async () => {
  const { ask } = await writer();
  const first = partOf<SpadeNetworkRow>(await ask({ type: "spade.network", agentId: "writer" }));
  const commands = first.policies.find((policy) => policy.which === "commands");
  expect(commands).toMatchObject({ title: "Commands reach", mode: "allow_list", own: false });
  const fallback = commands?.sites[0]?.entry;
  if (!fallback) throw new Error("no default sites");
  expect(commands?.sites[0]).toMatchObject({ line: "Default", action: "Remove" });

  const added = partOf<SpadeNetworkRow>(
    await ask({
      type: "spade.network.set",
      agentId: "writer",
      which: "commands",
      change: { add: "example.com" },
    }),
  );
  const mine = added.policies.find((policy) => policy.which === "commands");
  expect(mine?.own).toBe(true);
  expect(mine?.sites[0]).toEqual({ entry: "example.com", line: null, action: "Remove" });

  const dropped = partOf<SpadeNetworkRow>(
    await ask({
      type: "spade.network.set",
      agentId: "writer",
      which: "commands",
      change: { removeDefault: fallback },
    }),
  );
  expect(
    dropped.policies
      .find((policy) => policy.which === "commands")
      ?.sites.find((site) => site.entry === fallback),
  ).toMatchObject({ line: "Default, removed", action: "Put back" });

  for (const change of [
    { removeDefault: fallback },
    { restoreDefault: fallback },
    { restoreDefault: fallback },
  ]) {
    const saved = partOf<SpadeNetworkRow>(
      await ask({ type: "spade.network.set", agentId: "writer", which: "commands", change }),
    );
    expect(
      saved.policies
        .find((policy) => policy.which === "commands")
        ?.sites.find((site) => site.entry === fallback),
    ).toMatchObject({ action: "removeDefault" in change ? "Put back" : "Remove" });
  }

  const host = partOf<SpadeNetworkRow>(
    await ask({
      type: "spade.network.set",
      agentId: "writer",
      which: "plugins",
      change: { add: "localhost:3000" },
    }),
  );
  expect(host.policies.find((policy) => policy.which === "plugins")?.hosts).toEqual([
    "localhost:3000",
  ]);

  const machine = partOf<SpadeNetworkRow>(
    await ask({
      type: "spade.network.set",
      agentId: "writer",
      which: "commands",
      change: { inherit: true },
    }),
  );
  expect(machine.policies.find((policy) => policy.which === "commands")).toMatchObject({
    own: false,
  });
});

test("a network rule Spade rejects keeps the old one and says why", async () => {
  const { ask } = await writer();
  const answer = await ask({
    type: "spade.network.set",
    agentId: "writer",
    which: "commands",
    change: { add: "not a host!" },
  });
  expect(answer).toMatchObject({ ok: false, title: "Couldn't change its network rule" });
  expect("message" in answer && answer.message).toBeTruthy();
  const after = partOf<SpadeNetworkRow>(await ask({ type: "spade.network", agentId: "writer" }));
  expect(after.policies.find((policy) => policy.which === "commands")).toMatchObject({
    own: false,
  });
});

test("checkpoints list newest first, restore one, and a restore while the bot works is refused in words", async () => {
  const { ask, api } = await writer((fake) => {
    fake.security.checkpoints.set("writer", [
      { id: "cp2", at: 2_000, reason: "person" },
      { id: "cp1", at: 1_000, reason: "auto" },
    ]);
  });
  const list = partOf<SpadeCheckpointRow[]>(
    await ask({ type: "spade.checkpoints", agentId: "writer" }),
  );
  expect(list).toEqual([
    { id: "cp2", at: 2_000, reason: "Taken by you" },
    { id: "cp1", at: 1_000, reason: "Automatic" },
  ]);

  expect(await ask({ type: "spade.restore", agentId: "writer", checkpoint: "cp1" })).toEqual({
    ok: true,
  });
  expect(api.security.restored.get("writer")).toEqual(["cp1"]);
  const after = partOf<SpadeCheckpointRow[]>(
    await ask({ type: "spade.checkpoints", agentId: "writer" }),
  );
  expect(after[0]?.reason).toBe("Before a restore");

  const bot = api.agents.find((agent) => agent.id === "writer");
  if (bot) bot.state = "working";
  expect(await ask({ type: "spade.restore", agentId: "writer", checkpoint: "cp2" })).toEqual({
    ok: false,
    title: "",
    message: "Writer is working. Stop it first.",
  });
  expect(api.security.restored.get("writer")).toEqual(["cp1"]);
});
