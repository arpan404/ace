import { expect, it } from "vitest";
import { setup } from "./testing/v2-session.ts";
import { z } from "zod";

it.each(["create", "get", "update", "switchModel"] as const)(
  "session %s rejection preserves bounded, redacted provider detail",
  async (operation) => {
    let fail = operation === "create";
    const hPromise = setup({
      secrets: ["mcp-open-secret"],
      runtime: {
        fetch: async (input, init) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          const method = init?.method ?? "GET";
          if (
            fail &&
            ((operation === "create" && url.pathname === "/api/session" && method === "POST") ||
              (operation === "get" &&
                /\/api\/session\/[^/]+$/.test(url.pathname) &&
                method === "GET") ||
              (operation === "update" &&
                /\/api\/session\/[^/]+$/.test(url.pathname) &&
                method === "PATCH") ||
              (operation === "switchModel" && url.pathname.endsWith("/model") && method === "POST"))
          )
            return new Response(
              JSON.stringify({
                _tag: "InvalidModelError",
                code: "invalid_model",
                title: "Model unavailable",
                detail:
                  "Unknown provider/model; password=ephemeral-test-secret; MCP value mcp-open-secret " +
                  "x".repeat(5000),
                message:
                  "Unknown provider/model; password=ephemeral-test-secret; MCP value mcp-open-secret",
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          return fetch(input, init);
        },
      },
    });
    const opening =
      operation === "create"
        ? hPromise
        : hPromise.then((h) => {
            fail = true;
            return h.open(
              "/one",
              h.session.nativeSessionId,
              undefined,
              "opencode-go/another-model",
            );
          });
    const error: unknown = await opening.catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: "invalid_model",
      title: "Model unavailable",
      detail: expect.stringContaining("Unknown provider/model"),
    });
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected opening failure");
    expect(error.message).toContain("Unknown provider/model");
    expect(error.message.length).toBeLessThanOrEqual(2400);
    expect(JSON.stringify(error)).not.toContain("ephemeral-test-secret");
    expect(JSON.stringify(error)).not.toContain("mcp-open-secret");
    expect(JSON.stringify(error).length).toBeLessThan(2800);
  },
);

it("server startup failures retain their transport cause without leaking the ephemeral password", async () => {
  const failed = setup({
    runtime: {
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.pathname === "/api/info")
          throw new Error("socket connection refused password=ephemeral-test-secret");
        return fetch(input, init);
      },
    },
  });
  const failure: unknown = await failed.catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: "Transport",
    detail: expect.stringContaining("socket connection refused"),
  });
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("Expected opening failure");
  expect(failure.message).not.toContain("ephemeral-test-secret");
});

it("concurrent rejected opens release their leases while an existing session remains usable", async () => {
  let reject = false;
  const h = await setup({
    runtime: {
      fetch: (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (reject && url.pathname === "/api/session" && init?.method === "POST")
          return Promise.resolve(
            new Response(
              JSON.stringify({
                code: "bad_payload",
                message: 'Cannot create: {"credentials":["opaque-login-value"]}',
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            ),
          );
        return fetch(input, init);
      },
    },
  });
  reject = true;
  const failures = await Promise.all(
    ["/failed-one", "/failed-two"].map((cwd) => h.open(cwd).catch((error: unknown) => error)),
  );
  for (const failure of failures) {
    expect(failure).toMatchObject({
      code: "bad_payload",
      detail: expect.stringContaining("Cannot create"),
    });
    expect(JSON.stringify(failure)).not.toContain("opaque-login-value");
  }
  await h.session.send([{ type: "text", text: "existing session still usable" }], "queue");
  reject = false;
  const recovered = await h.open("/recovered");
  await recovered.send([{ type: "text", text: "recovered session usable" }], "queue");
  const requests = z
    .array(z.object({ path: z.string(), body: z.unknown().optional() }))
    .parse(await h.control("/test/requests"));
  expect(
    requests.filter((request) => request.path.endsWith("/prompt")).map((request) => request.body),
  ).toEqual([
    expect.objectContaining({ text: "existing session still usable" }),
    expect.objectContaining({ text: "recovered session usable" }),
  ]);
  await h.adapter.close();
  await expect(h.open("/after-shutdown")).rejects.toThrow("closed");
});
