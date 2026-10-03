import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { codexDiscoveryApi, claudeDiscoveryApi, openCodeDiscoveryApi } from "./index.ts";
import { deferred } from "./test-support.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
it("aggregates Codex status pages through the read-only RPC and refuses a repeated cursor", async () => {
  const api = codexDiscoveryApi({
    async request(method, params) {
      if (method !== "mcpServerStatus/list" || params.limit !== 100)
        throw new Error("Invalid native request");
      return params.cursor === undefined
        ? { data: [{ name: "first" }], nextCursor: "next" }
        : { data: [{ name: "second" }], nextCursor: null };
    },
  });
  expect(await api.read(new AbortController().signal)).toEqual({
    data: [{ name: "first" }, { name: "second" }],
  });
  const looping = codexDiscoveryApi({
    async request() {
      return { data: [], nextCursor: "loop" };
    },
  });
  await expect(looping.read(new AbortController().signal)).rejects.toThrow("Repeated");
});
it("reads Claude SDK status without mutating server configuration and abandons a cancelled read", async () => {
  const result = [{ name: "server", status: "connected" }];
  expect(
    await claudeDiscoveryApi({
      async mcpServerStatus() {
        return result;
      },
    }).read(new AbortController().signal),
  ).toEqual(result);
  const pending = deferred<unknown>();
  const lifetime = new AbortController();
  const response = claudeDiscoveryApi({
    mcpServerStatus() {
      return pending.promise;
    },
  }).read(lifetime.signal);
  lifetime.abort();
  await expect(response).rejects.toThrow("cancelled");
  pending.resolve(result);
});
it("reads directory-scoped OpenCode MCP status over real HTTP and caps the response", async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "", "http://localhost");
    if (request.method !== "GET" || url.pathname !== "/mcp") {
      response.writeHead(405).end();
      return;
    }
    if (url.searchParams.get("directory") === "/large") {
      response.end("x".repeat(512 * 1024 + 1));
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        server: { status: "connected", directory: url.searchParams.get("directory") },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const url = `http://127.0.0.1:${address.port}`;
  expect(
    await openCodeDiscoveryApi({ url, directory: "/project with spaces", fetch }).read(
      new AbortController().signal,
    ),
  ).toEqual({ server: { status: "connected", directory: "/project with spaces" } });
  await expect(
    openCodeDiscoveryApi({ url, directory: "/large", fetch }).read(new AbortController().signal),
  ).rejects.toThrow("capacity");
});
