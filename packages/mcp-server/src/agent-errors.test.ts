import { expect, it } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry, PublicToolError } from "./index.ts";
import { scope } from "./test-support.ts";

it("only intentional fixed failures reach agents; raw messages, hints, stacks and code-shaped objects stay private", async () => {
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  const lease = new CredentialRegistry(() => "a".repeat(64)).issue(
    scope("root", ["browser"]),
    new AbortController().signal,
  );
  registry.registerContent({
    name: "ace_browser_click",
    capability: "browser",
    description: "Click",
    timeoutMs: 1000,
    input: z.strictObject({ ref: z.string() }),
    async run(args) {
      if (args.ref === "public") {
        const error = new PublicToolError("target_gone");
        error.message = `secret bearer material ${lease.bearer}`;
        throw error;
      }
      if (args.ref === "origin") {
        class OriginFailure extends PublicToolError {
          readonly blocked = {
            origin: `https://${lease.bearer}.example.invalid/path`,
            reason: "denied" as const,
          };
        }
        throw new OriginFailure("denied");
      }
      if (args.ref === "plain")
        return Promise.reject({
          code: "target_gone",
          message: "secret bearer material",
          hint: "secret recovery hint",
        });
      if (args.ref === "schema")
        z.object({ secret: z.literal("private literal") }).parse({ secret: "no" });
      throw new Error(`secret bearer material ${lease.bearer}`);
    },
  });
  const call = (ref: string) =>
    registry.call("ace_browser_click", { ref }, lease.principal, new AbortController().signal);
  for (const ref of ["public", "plain", "schema", "raw", "origin"]) {
    const result = await call(ref);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/secret|private literal|at |[a-f0-9]{64}/);
  }
  expect(await call("public")).toMatchObject({
    content: [{ text: expect.stringContaining('"code":"target_gone"') }],
  });
  expect(await call("plain")).toMatchObject({
    content: [{ text: expect.stringContaining('"code":"execution_failed"') }],
  });
  expect(await call("schema")).toMatchObject({
    content: [{ text: expect.stringContaining('"code":"invalid_data"') }],
  });
  expect(
    await registry.call(
      "ace_browser_click",
      { ref: 42 },
      lease.principal,
      new AbortController().signal,
    ),
  ).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("invalid_arguments") }],
  });
  lease.end();
});

it("native delivery reasons and dispatch phases reach agents without raw helper messages", async () => {
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  const credentials = new CredentialRegistry(() => "b".repeat(64));
  const lease = credentials.issue(scope("root", ["screen"]), new AbortController().signal);
  registry.registerContent({
    name: "screen_key",
    capability: "screen",
    description: "Key",
    timeoutMs: 1000,
    input: z.strictObject({ dispatched: z.boolean() }),
    async run(args) {
      const error = new PublicToolError(
        args.dispatched ? "delivery_unconfirmed" : "key_unsupported",
        undefined,
        args.dispatched ? "dispatched" : "rejected-before-dispatch",
      );
      error.message = "private helper text";
      throw error;
    },
  });
  try {
    for (const dispatched of [true, false]) {
      const result = await registry.call(
        "screen_key",
        { dispatched },
        lease.principal,
        new AbortController().signal,
      );
      const content = result.content[0];
      if (content?.type !== "text") throw new Error("Missing public failure");
      const failure = z
        .object({ code: z.string(), phase: z.string(), hint: z.string() })
        .parse(JSON.parse(content.text));
      expect(failure.code).toBe(dispatched ? "delivery_unconfirmed" : "key_unsupported");
      expect(failure.phase).toBe(dispatched ? "dispatched" : "rejected-before-dispatch");
      if (dispatched) expect(failure.hint).toContain("Do not retry automatically");
      expect(content.text).not.toContain("private helper text");
    }
  } finally {
    lease.end();
    credentials.close();
  }
});

it("ambiguous windows expose candidate IDs without arbitrary helper text", async () => {
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  const credentials = new CredentialRegistry(() => "c".repeat(64));
  const lease = credentials.issue(scope("root", ["screen"]), new AbortController().signal);
  registry.registerContent({
    name: "screen_window",
    capability: "screen",
    description: "Window",
    timeoutMs: 1000,
    input: z.strictObject({}),
    async run() {
      throw new PublicToolError("window_ambiguous", undefined, "rejected-before-dispatch", [
        { windowId: 42, title: "private helper text" },
        { windowId: 43 },
      ]);
    },
  });
  try {
    const result = await registry.call(
      "screen_window",
      {},
      lease.principal,
      new AbortController().signal,
    );
    const content = result.content[0];
    if (content?.type !== "text") throw new Error("Missing public failure");
    expect(JSON.parse(content.text)).toMatchObject({
      code: "window_ambiguous",
      candidates: [{ windowId: 42 }, { windowId: 43 }],
    });
    expect(content.text).not.toContain("private helper text");
  } finally {
    lease.end();
    credentials.close();
  }
});
