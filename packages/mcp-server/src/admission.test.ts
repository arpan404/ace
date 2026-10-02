import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { Agent, Thread } from "@ace/protocol";
import { registerBuiltins } from "./index.ts";
import { deferred, harness, scope, thread, toolHeaders, toolRequest } from "./test-support.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
const scheduler = { after: () => () => {} };
const schema = z.strictObject({ value: z.string() });

it("rejects registration beyond the tool limit while admitted tools remain callable", async () => {
  const h = await harness(cleanups, scheduler, { maxTools: 1 });
  const tool = {
    name: "ace_first",
    description: "Echo",
    input: schema,
    output: schema,
    capability: null,
    timeoutMs: 1000,
    async run(value: { value: string }) {
      return value;
    },
  };
  h.registry.register(tool);
  expect(() => h.registry.register({ ...tool, name: "ace_excess" })).toThrow(
    "Tool capacity reached",
  );
  const { client } = await h.connect();
  expect((await client.listTools()).tools.map((entry) => entry.name)).toEqual(["ace_first"]);
  expect(
    await client.callTool({ name: "ace_first", arguments: { value: "accepted" } }),
  ).toMatchObject({
    structuredContent: { value: "accepted" },
  });
  expect(
    await client.callTool({ name: "ace_excess", arguments: { value: "excess" } }),
  ).toMatchObject({ isError: true });
});

for (const limit of ["tools", "HTTP"] as const) {
  it(`rejects excess ${limit} work before effects and admits work after completion`, async () => {
    const h = await harness(
      cleanups,
      scheduler,
      limit === "tools" ? { maxCalls: 1 } : { maxRequests: 1 },
    );
    const started = deferred<void>();
    const release = deferred<void>();
    const effects: string[] = [];
    h.registry.register({
      name: "ace_echo",
      description: "Echo",
      input: schema,
      output: schema,
      capability: null,
      timeoutMs: 1000,
      async run(value) {
        effects.push(value.value);
        if (value.value === "first") {
          started.resolve();
          await release.promise;
        }
        return value;
      },
    });
    const lease = h.credentials.issue(scope(), new AbortController().signal);
    let id = 0;
    const send = (value: string) =>
      fetch(h.server.url, {
        method: "POST",
        headers: toolHeaders(lease.bearer, "ace_echo"),
        body: JSON.stringify({ ...toolRequest("ace_echo", { value }), id: ++id }),
      });
    const first = send("first");
    await started.promise;
    try {
      const denied = await send("denied");
      if (limit === "HTTP") expect(denied.status).toBe(503);
      else {
        expect(denied.status).toBe(200);
        expect(await denied.json()).toMatchObject({
          result: { isError: true, content: [{ text: "Tool capacity reached" }] },
        });
      }
      expect(effects).toEqual(["first"]);
    } finally {
      release.resolve();
      await first;
    }
    expect(await (await first).json()).toMatchObject({
      result: { structuredContent: { value: "first" } },
    });
    expect(await (await send("recovered")).json()).toMatchObject({
      result: { structuredContent: { value: "recovered" } },
    });
    expect(effects).toEqual(["first", "recovered"]);
  });
}

for (const resource of ["thread", "agents"] as const) {
  it(`rejects a foreign-thread ${resource} read port without exposing its data`, async () => {
    const h = await harness(cleanups, scheduler);
    const foreign = Thread.parse({
      ...thread,
      id: "foreign-thread",
      title: "private foreign title",
    });
    const agent = Agent.parse({
      id: "foreign-agent",
      threadId: foreign.id,
      parentId: null,
      origin: "root",
      native: { provider: "codex" },
      fidelity: "full",
      cwd: "/private-foreign",
      status: { state: "idle" },
      createdAt: 1,
    });
    registerBuiltins(
      h.registry,
      {
        async thread() {
          return foreign;
        },
        async agents() {
          return { agents: [agent], nextCursor: null };
        },
      },
      {
        async notify() {
          throw new Error("Unexpected notification");
        },
        async spawn() {
          throw new Error("Unexpected spawn");
        },
      },
    );
    const { client } = await h.connect();
    const result = await client.callTool({
      name: resource === "thread" ? "ace_thread_info" : "ace_list_agents",
    });
    expect(result).toMatchObject({ isError: true });
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("foreign");
  });
}
