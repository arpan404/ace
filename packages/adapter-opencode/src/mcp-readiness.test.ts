import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { z } from "zod";
import plugin from "./mcp-ready-plugin/server.ts";

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

test("the installed OpenCode tool-list shape makes described ace tools available through readiness", async () => {
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
  const h = await host();
  const signal = new AbortController().signal;
  const ready = h.rpc.ready({}, { signal });
  h.reload(
    fixture.tools.map((tool) => ({
      id: tool.function.name,
      description: tool.function.description,
      options: { namespace: tool.function.name.startsWith("ace_") ? "ace" : "builtin" },
    })),
  );
  const result = await ready;
  expect(result.tools).toEqual(
    expect.arrayContaining([
      { name: "ace_ace_status", description: expect.stringContaining("ace://status") },
      { name: "ace_ace_thread_info", description: expect.any(String) },
      { name: "ace_ace_list_agents", description: expect.any(String) },
    ]),
  );
  expect(result.tools.some((tool) => tool.name === "shell")).toBe(false);
});

test("a connected MCP client with no native status tool cannot pass readiness and can be cancelled", async () => {
  const h = await host();
  h.reload([
    { id: "ace_ace_thread_info", description: "Thread info", options: { namespace: "ace" } },
  ]);
  const controller = new AbortController();
  const ready = h.rpc.ready({}, { signal: controller.signal });
  controller.abort();
  await expect(ready).rejects.toThrow("ace MCP readiness cancelled");
});
