import { expect, test } from "vitest";
import { discoverOpenCodeModels } from "./index.ts";
import { setup } from "./testing/v2-session.ts";

test.each([401, 403, 429, 500, 503])(
  "HTTP %s from OpenCode model discovery retains the reason without response text",
  async (status) => {
    const h = await setup({
      runtime: {
        fetch: async (input, init) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          if (url.pathname === "/api/model")
            return Response.json(
              { message: "Unauthorized Bearer private-token", password: "private-password" },
              { status },
            );
          return fetch(input, init);
        },
      },
    });
    await expect(
      discoverOpenCodeModels(h.options, "/one", new AbortController().signal),
    ).rejects.toMatchObject({
      code: status === 429 ? "rate_limited" : status < 500 ? "auth_expired" : "unreachable",
      message: "OpenCode model discovery failed",
    });
  },
);

test("a rejected OpenCode model connection reports unreachable", async () => {
  const h = await setup({
    runtime: {
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.pathname === "/api/model") throw new TypeError("fetch failed private-host");
        return fetch(input, init);
      },
    },
  });
  await expect(
    discoverOpenCodeModels(h.options, "/one", new AbortController().signal),
  ).rejects.toMatchObject({ code: "unreachable" });
});

test("an OpenCode proxy's non-JSON forbidden response preserves authentication failure", async () => {
  const h = await setup({
    runtime: {
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.pathname === "/api/model")
          return new Response("private proxy diagnostic", { status: 403 });
        return fetch(input, init);
      },
    },
  });
  await expect(
    discoverOpenCodeModels(h.options, "/one", new AbortController().signal),
  ).rejects.toMatchObject({ code: "auth_expired" });
});

test.each(
  ["/api/info", "/openapi.json", "/api/event"].flatMap((path) =>
    [401, 403, 503].map((status) => ({ path, status })),
  ),
)(
  "OpenCode startup HTTP $status at $path survives the session-opening wrapper",
  async ({ path, status }) => {
    let rejectStartup = false;
    const h = await setup({
      runtime: {
        fetch: async (input, init) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          if (rejectStartup && url.pathname === path)
            return Response.json(
              {
                message: "private startup diagnostic",
                headers: { authorization: "Bearer private-token" },
              },
              { status },
            );
          return fetch(input, init);
        },
      },
    });
    rejectStartup = true;
    await expect(
      discoverOpenCodeModels(h.options, "/one", new AbortController().signal),
    ).rejects.toMatchObject({
      code: status < 500 ? "auth_expired" : "unreachable",
    });
  },
);
