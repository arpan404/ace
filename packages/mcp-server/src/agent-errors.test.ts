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
