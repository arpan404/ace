import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { DeviceId, WorkspaceId, type ServerMessage, type SkillResult } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "./index.ts";

async function connect(daemon: FakeDaemon) {
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("skills-device"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `skills-${++sequence}`,
  });
  const ready = Promise.withResolvers<void>();
  const stop = client.connectionState().subscribe(() => {
    if (client.state === "ready") ready.resolve();
  });
  await client.start();
  await ready.promise;
  stop();
  return client;
}
function skill(result: SkillResult) {
  if (result.kind !== "skill") throw new Error(`Expected a skill, got ${result.kind}`);
  return result;
}
const project = WorkspaceId.parse("project");

test("fake skill library lists each skill once with where it lives and who reads it", async () => {
  const client = await connect(new FakeDaemon({ clock: () => 1000 }));
  try {
    const { result } = await client.request({
      type: "skills.request",
      operation: { op: "list", workspaceId: project },
    });
    if (result.kind !== "list") throw new Error(result.kind);
    expect(new Set(result.entries.map((entry) => entry.scope))).toEqual(
      new Set(["project", "personal", "builtin", "plugin"]),
    );
    const research = result.entries.find((entry) => entry.name === "research");
    expect(research?.agents.map((a) => [a.provider, a.via])).toEqual([
      ["claude", "link"],
      ["codex", "native"],
      ["opencode", "native"],
      ["cursor", "native"],
      ["pi", "native"],
    ]);
    const other = await client.request({ type: "skills.request", operation: { op: "list" } });
    expect(
      other.result.kind === "list" && other.result.entries.some((e) => e.scope === "project"),
    ).toBe(false);
  } finally {
    await client.close();
  }
});

test("fake skill edits push the new list and reject a stale hash", async () => {
  const client = await connect(new FakeDaemon({ clock: () => 1000 }));
  const pushes: ServerMessage[] = [];
  const changed = Promise.withResolvers<void>();
  const stop = client.onMessage((m) => {
    if (m.type === "skills.changed") {
      pushes.push(m);
      changed.resolve();
    }
  });
  try {
    const listed = await client.request(
      { type: "skills.request", operation: { op: "list", subscribe: true } },
      { requestId: "skills-watch" },
    );
    if (listed.result.kind !== "list") throw new Error(listed.result.kind);
    const tdd = listed.result.entries.find((entry) => entry.name === "tdd");
    if (!tdd) throw new Error("Missing tdd");
    const edit = {
      op: "edit" as const,
      id: tdd.id,
      expectedHash: tdd.hash,
      description: "Red, green, refactor.",
      body: "# TDD\n\nWrite the failing test first.\n",
      manual: true,
    };
    const saved = skill((await client.request({ type: "skills.request", operation: edit })).result);
    expect(saved.entry).toMatchObject({ description: "Red, green, refactor.", manual: true });
    expect(saved.text).toContain("disable-model-invocation: true");
    await changed.promise;
    expect(pushes[0]).toMatchObject({
      requestId: "skills-watch",
      entries: expect.arrayContaining([expect.objectContaining({ id: tdd.id, manual: true })]),
    });
    const stale = await client.request({ type: "skills.request", operation: edit });
    expect(stale.result).toMatchObject({ kind: "error", code: "conflict" });
  } finally {
    stop();
    await client.close();
  }
});

test("fake setAgents keeps copies and the canonical folder's agents", async () => {
  const client = await connect(new FakeDaemon({ clock: () => 1000 }));
  try {
    const listed = await client.request({ type: "skills.request", operation: { op: "list" } });
    if (listed.result.kind !== "list") throw new Error(listed.result.kind);
    const cloudflare = listed.result.entries.find((entry) => entry.name === "cloudflare");
    if (!cloudflare) throw new Error("Missing cloudflare");
    const result = skill(
      (
        await client.request({
          type: "skills.request",
          operation: { op: "setAgents", id: cloudflare.id, agents: [] },
        })
      ).result,
    );
    expect(result.kept).toEqual(
      expect.arrayContaining([
        { provider: "claude", reason: "canonical" },
        { provider: "codex", reason: "copy" },
      ]),
    );
    const builtin = listed.result.entries.find((entry) => entry.scope === "builtin");
    if (!builtin) throw new Error("Missing builtin");
    const refused = await client.request({
      type: "skills.request",
      operation: { op: "delete", id: builtin.id, expectedHash: builtin.hash },
    });
    expect(refused.result).toMatchObject({ kind: "error", code: "read_only" });
  } finally {
    await client.close();
  }
});
