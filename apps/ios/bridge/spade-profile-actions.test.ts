import { expect, test } from "vitest";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";
import type {
  SpadeAppsRow,
  SpadeDeleteRow,
  SpadeMoveRow,
  SpadePluginsRow,
} from "./spade-profile-access.ts";

/*
 * What a bot may use and where it lives, from its iPhone profile, over the real SDK, a fake
 * daemon and a fake Spade: its apps and plugins added and removed, a move started on one machine
 * and accepted on another, and Delete asking first for a bot that made workers.
 */

function partOf<T>(answer: unknown): T {
  if (typeof answer !== "object" || answer === null || !("part" in answer))
    throw new Error(JSON.stringify(answer));
  return answer.part as T;
}

const app = (id: string, name: string, state = "connected") => ({
  id,
  name,
  url: `https://${id}.example/mcp`,
  state,
  account: `${id}-me`,
  tools: 2,
});

async function listed(seed: Parameters<typeof setUp>[0], id = "writer") {
  const host = await setUp(seed);
  await until(() => host.patches.state?.list.rows?.some((row) => row.id === id) === true);
  return host;
}

test("an app added to a bot shows with its account, and Remove takes it away again", async () => {
  const { ask, api } = await listed((fake) => {
    fake.addAgent({ id: "writer", name: "Writer" });
    fake.connectors.connectors = [
      app("github", "GitHub"),
      app("linear", "Linear"),
      app("notion", "Notion", "signing_in"),
    ];
  });
  const none = partOf<SpadeAppsRow>(await ask({ type: "spade.apps", agentId: "writer" }));
  // A new bot has none; one still signing in has nothing to give yet.
  expect(none).toEqual({
    allowed: [],
    others: [
      { id: "github", name: "GitHub" },
      { id: "linear", name: "Linear" },
    ],
  });

  const added = partOf<SpadeAppsRow>(
    await ask({ type: "spade.app", agentId: "writer", connector: "github", on: true }),
  );
  expect(added.allowed).toEqual([{ id: "github", name: "GitHub", account: "github-me" }]);
  expect(api.connectors.access.get("writer")).toEqual({ all: false, connectors: ["github"] });

  const removed = partOf<SpadeAppsRow>(
    await ask({ type: "spade.app", agentId: "writer", connector: "github", on: false }),
  );
  expect(removed.allowed).toEqual([]);
  expect(api.connectors.access.get("writer")).toEqual({ all: false, connectors: [] });
});

test("removing one app from Spade, which uses every app, keeps the rest", async () => {
  const { ask } = await listed((fake) => {
    fake.addAgent({ id: "spade", name: "Spade", kind: "main" });
    fake.connectors.connectors = [app("github", "GitHub"), app("linear", "Linear")];
  }, "spade");
  const narrowed = partOf<SpadeAppsRow>(
    await ask({ type: "spade.app", agentId: "spade", connector: "github", on: false }),
  );
  expect(narrowed.allowed.map((each) => each.id)).toEqual(["linear"]);
});

test("removing a connected app keeps saved IDs absent from the catalogue", async () => {
  const { ask, api } = await listed((fake) => {
    fake.addAgent({ id: "writer", name: "Writer" });
    fake.connectors.connectors = [app("github", "GitHub")];
    fake.connectors.access.set("writer", { all: false, connectors: ["github", "missing"] });
  });
  expect(
    await ask({ type: "spade.app", agentId: "writer", connector: "github", on: false }),
  ).toMatchObject({ ok: true });
  expect(api.connectors.access.get("writer")).toEqual({ all: false, connectors: ["missing"] });
});

test("a plugin switched on for a bot reaches only it, and one off in ace says so", async () => {
  const { ask, api } = await listed((fake) => {
    fake.addAgent({ id: "writer", name: "Writer" });
    fake.addAgent({ id: "reader", name: "Reader" });
    fake.plugins.plugins = [
      { name: "house-style", version: "1.0.0", rules: ["style.md"] },
      { name: "old-lint", version: "0.3.0", enabled_in_ace: false },
    ];
  });
  const page = partOf<SpadePluginsRow>(await ask({ type: "spade.plugins", agentId: "writer" }));
  expect(page.plugins).toEqual([
    { name: "house-style", line: "1 rule", on: false, offInAce: false, notes: [] },
    { name: "old-lint", line: "Turned off in ace", on: false, offInAce: true, notes: [] },
  ]);

  const on = partOf<SpadePluginsRow>(
    await ask({ type: "spade.plugin", agentId: "writer", name: "house-style", on: true }),
  );
  expect(on.plugins[0]?.on).toBe(true);
  expect(api.plugins.allowed.get("writer")).toEqual(["house-style"]);

  const reader = partOf<SpadePluginsRow>(await ask({ type: "spade.plugins", agentId: "reader" }));
  expect(reader.plugins[0]).toMatchObject({ name: "house-style", on: false });

  const off = partOf<SpadePluginsRow>(
    await ask({ type: "spade.plugin", agentId: "writer", name: "house-style", on: false }),
  );
  expect(off.plugins[0]?.on).toBe(false);
});

test("a move starts on the bot's machine and the person accepts it on the one it goes to", async () => {
  const from = await listed((fake) => {
    fake.addAgent({ id: "writer", name: "Writer" });
    fake.here = "mac-mini";
    fake.machineNames.set("studio", "Studio");
  });
  const to = await setUp();

  const started = partOf<SpadeMoveRow | null>(
    await from.ask({ type: "spade.move.start", agentId: "writer", to: "studio", move: "mv_0a1b" }),
  );
  expect(started).toMatchObject({ moving: true, failed: false, canCancel: true, to: "studio" });
  expect(started?.line).toMatch(/Studio/);
  const accept = started?.accept;
  if (!accept) throw new Error("the move isn't packed");
  expect(accept).toMatchObject({ bot: "writer", to: "studio", from: "mac-mini", replaces: "bot" });

  expect(await to.ask({ type: "spade.move.accept", move: "mv_0a1b", accept })).toEqual({
    ok: true,
  });
  expect(to.api.acceptedMoves.get("mv_0a1b")).toBe("writer");

  // Cancel while it still copies: the move is gone.
  expect(await from.ask({ type: "spade.move.end", agentId: "writer", action: "cancel" })).toEqual({
    ok: true,
  });
  expect(partOf(await from.ask({ type: "spade.move.read", agentId: "writer" }))).toBeNull();
});

test("a bot that works can't move, and says why", async () => {
  const { ask } = await listed((fake) => {
    fake.addAgent({ id: "writer", name: "Writer", state: "working" });
  });
  const answer = await ask({
    type: "spade.move.start",
    agentId: "writer",
    to: "studio",
    move: "mv_0a1b",
  });
  expect(answer).toMatchObject({
    ok: false,
    title: "Couldn't move Writer",
    message: expect.stringMatching(/working/),
  });
});

test("deleting a bot that made workers asks first, and its workers stay as the person's", async () => {
  const { ask, api } = await listed((fake) => {
    fake.addAgent({ id: "writer", name: "Writer" });
    fake.addAgent({
      id: "notes",
      name: "Notes",
      state: "working",
      parent: { id: "writer", name: "Writer" },
    });
  });
  const asked = partOf<SpadeDeleteRow>(await ask({ type: "spade.delete.ask", agentId: "writer" }));
  expect(asked).toEqual({
    asks: true,
    stop: "Notes stays as your bot, stopped.",
    keep: "They carry on as your own bots.",
    aceStops: false,
  });

  expect(await ask({ type: "spade.delete", agentId: "writer", workers: "stop" })).toEqual({
    ok: true,
  });
  expect(api.agents.map((agent) => agent.id)).toEqual(["notes"]);
  expect(api.agents[0]).toMatchObject({ parent: null, state: "idle" });
});

test("deleting a bot stops its ace threads whichever way its workers go, and says so", async () => {
  const { ask, api } = await listed((fake) => {
    fake.addAgent({ id: "writer", name: "Writer" });
    fake.addAgent({ id: "notes", name: "Notes", parent: { id: "writer", name: "Writer" } });
    fake.addAgent({ id: "coder", name: "Coder" });
  });
  api.work.addAce("writer", { id: "t1", name: "Fix the build", state: "working" });
  api.work.addAce("coder", { id: "t2", name: "Tidy", state: "working" });

  const both = partOf<SpadeDeleteRow>(await ask({ type: "spade.delete.ask", agentId: "writer" }));
  expect(both).toEqual({
    asks: true,
    stop: "Notes stays as your bot, stopped. Its ace threads stop.",
    keep: "They carry on as your own bots. Its ace threads stop.",
    aceStops: true,
  });
  // Only ace threads: there is nothing to choose, and the plain confirm says they stop.
  const aceOnly = partOf<SpadeDeleteRow>(await ask({ type: "spade.delete.ask", agentId: "coder" }));
  expect(aceOnly).toMatchObject({ asks: false, aceStops: true });
  expect(await ask({ type: "spade.delete", agentId: "coder" })).toEqual({ ok: true });
});

test("deleting a bot with no workers asks nothing, and Spade itself can't be deleted", async () => {
  const { ask, api } = await listed((fake) => {
    fake.addAgent({ id: "spade", name: "Spade", kind: "main" });
    fake.addAgent({ id: "writer", name: "Writer" });
  });
  expect(
    partOf<SpadeDeleteRow>(await ask({ type: "spade.delete.ask", agentId: "writer" })).asks,
  ).toBe(false);
  expect(await ask({ type: "spade.delete", agentId: "writer" })).toEqual({ ok: true });
  expect(await ask({ type: "spade.delete", agentId: "spade" })).toMatchObject({ ok: false });
  expect(api.agents.map((agent) => agent.id)).toEqual(["spade"]);
});
