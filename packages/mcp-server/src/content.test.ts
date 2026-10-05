import { expect, it } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry } from "./index.ts";
import { scope, deferred } from "./test-support.ts";

function fixture() {
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  const lifetime = new AbortController();
  const { principal } = credentials.issue(scope("root", ["screen"]), lifetime.signal);
  return {
    registry,
    lifetime,
    call: (name: string, input: unknown = {}) =>
      registry.call(name, input, principal, new AbortController().signal),
  };
}
it("rich results preserve image bytes while structured tools retain their smaller budget", async () => {
  const f = fixture();
  const data = Buffer.from("pixel".repeat(60_000)).toString("base64");
  f.registry.registerContent({
    name: "screen_screenshot",
    description: "Visual check",
    input: z.object({}),
    capability: "screen",
    timeoutMs: 1000,
    run: async () => ({ content: [{ type: "image", data, mimeType: "image/jpeg" }] }),
  });
  expect(await f.call("screen_screenshot")).toEqual({
    content: [{ type: "image", data, mimeType: "image/jpeg" }],
  });
  f.registry.register({
    name: "ace_text",
    description: "Structured",
    input: z.object({}),
    output: z.object({ data: z.string() }),
    capability: null,
    timeoutMs: 1000,
    run: async () => ({ data }),
  });
  expect(await f.call("ace_text")).toMatchObject({
    isError: true,
    content: [{ text: "Tool result too large" }],
  });
});
it("rich result validation rejects malformed and oversized content before exposing it", async () => {
  const f = fixture();
  f.registry.registerContent({
    name: "screen_invalid",
    description: "Boundary",
    input: z.object({ large: z.boolean() }),
    capability: "screen",
    timeoutMs: 1000,
    run: async ({ large }) =>
      large
        ? {
            content: [
              { type: "image", data: "x".repeat(12 * 1024 * 1024), mimeType: "image/jpeg" },
            ],
          }
        : { content: [{ type: "image", data: 42, mimeType: "image/jpeg" }] },
  });
  expect(await f.call("screen_invalid", { large: false })).toMatchObject({
    isError: true,
    content: [
      { text: JSON.stringify({ code: "execution_failed", message: "Invalid MCP tool content" }) },
    ],
  });
  expect(await f.call("screen_invalid", { large: true })).toMatchObject({
    isError: true,
    content: [{ text: "Tool result too large" }],
  });
});
it("screen names require screen authority and revoked callers cannot receive a late image", async () => {
  const f = fixture();
  const started = deferred<void>();
  const release = deferred<void>();
  const definition = {
    name: "screen_screenshot",
    description: "Visual check",
    input: z.object({}),
    capability: "screen" as const,
    timeoutMs: 1000,
    run: async () => {
      started.resolve();
      await release.promise;
      return { content: [{ type: "image", data: "late", mimeType: "image/jpeg" }] };
    },
  };
  expect(() => f.registry.registerContent({ ...definition, capability: "browser" })).toThrow();
  f.registry.registerContent(definition);
  const result = f.call("screen_screenshot");
  await started.promise;
  f.lifetime.abort();
  release.resolve();
  expect(await result).toMatchObject({ isError: true });
  expect(JSON.stringify(await result)).not.toContain("late");
});
