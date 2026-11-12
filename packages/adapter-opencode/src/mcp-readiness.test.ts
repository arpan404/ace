import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { z } from "zod";
import type { OpenCodeClient } from "@opencode/client";
import plugin from "./mcp-ready-plugin/server.ts";
import { readinessStep, waitForAceTools } from "./mcp-ready.ts";
import { harness } from "./replay.ts";
import { runtime } from "./runtime.ts";

type Context = Parameters<typeof plugin.setup>[0];
type Tool = Awaited<ReturnType<Context["tool"]["list"]>>[number];
async function host() {
  let tools: readonly Tool[] = [];
  const transforms: Parameters<Context["tool"]["transform"]>[0][] = [];
  const registered = Promise.withResolvers<Parameters<Context["rpc"]["register"]>[1]>();
  await plugin.setup({
    tool: {
      async transform(read) {
        transforms.push(read);
        read({ list: () => tools });
      },
      async list() {
        return tools;
      },
    },
    rpc: {
      async register(_, handlers) {
        registered.resolve(handlers);
      },
    },
  });
  return {
    rpc: await registered.promise,
    reload(catalog: readonly Tool[]) {
      tools = catalog;
      for (const read of transforms) read({ list: () => tools });
    },
  };
}

test("readiness answers with ace's native tools once OpenCode registers ace_context, leaving OpenCode's own tools out", async () => {
  const fixture = z
    .object({
      tools: z.array(
        z.object({ function: z.object({ name: z.string(), description: z.string() }) }),
      ),
    })
    .parse(
      JSON.parse(
        await readFile(
          new URL("./__fixtures__/ace-native-tools-2.0.22.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  // The recorded 2.0.22 catalog supplies OpenCode's own tools in their installed shape. It
  // predates ace's bare tool names, so ace's entries follow OpenCode's `<server>_<tool>` rule.
  const native = fixture.tools
    .filter((tool) => !tool.function.name.startsWith("ace_"))
    .map((tool) => ({
      id: tool.function.name,
      description: tool.function.description,
      options: { namespace: "builtin" },
    }));
  const ace = [
    { id: "ace_context", description: "What ace already knows", options: { namespace: "ace" } },
    { id: "ace_threads_find", description: "Find threads", options: { namespace: "ace" } },
  ];
  expect(native.some((tool) => tool.id === "shell")).toBe(true);
  const h = await host();
  const signal = new AbortController().signal;
  const ready = h.rpc.ready({}, { signal });
  h.reload(native);
  h.reload([...native, ...ace]);
  const result = await ready;
  expect(result.tools).toEqual([
    { name: "ace_context", description: "What ace already knows" },
    { name: "ace_threads_find", description: "Find threads" },
  ]);
});

test("a connected MCP client with no native context tool cannot pass readiness and can be cancelled", async () => {
  const h = await host();
  h.reload([
    { id: "ace_threads_find", description: "Find threads", options: { namespace: "ace" } },
  ]);
  const controller = new AbortController();
  const ready = h.rpc.ready({}, { signal: controller.signal });
  controller.abort();
  await expect(ready).rejects.toThrow("ace MCP readiness cancelled");
});

test("a plugin OpenCode activates after ace's tools loaded answers readiness from the current catalog", async () => {
  const registered = Promise.withResolvers<Parameters<Context["rpc"]["register"]>[1]>();
  const tools = [
    { id: "ace_context", description: "What ace already knows", options: { namespace: "ace" } },
  ];
  // No reload follows activation, so the transform never sees ace's tools.
  await plugin.setup({
    tool: { async transform() {}, list: async () => tools },
    rpc: {
      async register(_, handlers) {
        registered.resolve(handlers);
      },
    },
  });
  const rpc = await registered.promise;
  await expect(rpc.ready({}, { signal: new AbortController().signal })).resolves.toEqual({
    tools: [{ name: "ace_context", description: "What ace already knows" }],
  });
});

const unavailable = { type: "rpc.unavailable", message: "RPC is unavailable: ace.mcp.readiness" };

test.each([
  [
    "an RPC OpenCode has not registered yet is retried soon",
    unavailable,
    0,
    10_000,
    { retryInMs: 100 },
  ],
  ["retries back off as the wait grows", unavailable, 900, 10_000, { retryInMs: 400 }],
  ["retries never wait longer than half a second", unavailable, 5_000, 10_000, { retryInMs: 500 }],
  [
    "an RPC still unregistered when patience ends leaves readiness unconfirmed",
    unavailable,
    9_600,
    10_000,
    "unconfirmed",
  ],
  ["no patience means one look and no retry", unavailable, 0, 0, "unconfirmed"],
  [
    "a plugin that answered with an error is a real failure",
    { type: "rpc.internal" },
    0,
    10_000,
    "fail",
  ],
  ["a transport failure is a real failure", new Error("socket closed"), 0, 10_000, "fail"],
] as const)("%s", (_, error, elapsed, patience, step) => {
  expect(readinessStep(error, elapsed, patience)).toEqual(step);
});

/** A client whose readiness RPC answers in turn from `replies`; errors are thrown. */
function readinessClient(replies: unknown[]) {
  let calls = 0;
  const client = {
    rpc: () => ({
      async ready() {
        const reply = replies[Math.min(calls++, replies.length - 1)];
        if (reply instanceof Error || (typeof reply === "object" && reply && "type" in reply))
          throw reply;
        return reply;
      },
    }),
  };
  // Only the readiness RPC is reachable from waitForAceTools.
  return { client: client as unknown as OpenCodeClient, calls: () => calls };
}
/** Pauses run at once and advance the clock by their length. */
function steppedRuntime() {
  let now = 0;
  return runtime({
    monotonic: () => now,
    schedule(callback, delay) {
      if (delay >= 10_000) return () => {};
      now += delay;
      queueMicrotask(callback);
      return () => {};
    },
  });
}
const ready = { tools: [{ name: "ace_context", description: "What ace already knows" }] };

test("ace's tools are confirmed once OpenCode finishes activating the readiness plugin", async () => {
  const fake = readinessClient([unavailable, unavailable, unavailable, ready]);
  await expect(waitForAceTools(fake.client, "/one", steppedRuntime())).resolves.toBe("ready");
  expect(fake.calls()).toBe(4);
});

test("a readiness plugin that never registers leaves ace's tools unconfirmed instead of failing", async () => {
  const fake = readinessClient([unavailable]);
  await expect(waitForAceTools(fake.client, "/one", steppedRuntime())).resolves.toBe("unconfirmed");
  expect(fake.calls()).toBeGreaterThan(10);
});

test("a registered plugin that reports ace's tools missing still fails readiness", async () => {
  const missing = readinessClient([unavailable, { tools: [] }]);
  await expect(waitForAceTools(missing.client, "/one", steppedRuntime())).rejects.toThrow(
    "OpenCode ace context tool is missing from its native catalog",
  );
  const broken = readinessClient([{ type: "rpc.internal", message: "RPC call failed" }]);
  await expect(waitForAceTools(broken.client, "/one", steppedRuntime())).rejects.toMatchObject({
    type: "rpc.internal",
  });
});

test("unconfirmed ace tools reach the daemon log as an adapter warning, not the transcript", () => {
  const h = harness();
  h.feed({ seq: 0, t: 0, dir: "note", channel: "lifecycle", data: { type: "started" } });
  h.translator.takeDiagnostics();
  h.feed({ seq: 1, t: 1, dir: "note", channel: "mcp.readiness", data: { type: "unconfirmed" } });
  expect(h.translator.takeDiagnostics()).toContainEqual({
    type: "adapter.warning",
    data: expect.objectContaining({ event: "mcp-readiness-unconfirmed" }),
  });
  expect(Object.values(h.view.items).filter((item) => item.type === "notice")).toEqual([]);
});
