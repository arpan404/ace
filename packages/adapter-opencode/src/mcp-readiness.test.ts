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
