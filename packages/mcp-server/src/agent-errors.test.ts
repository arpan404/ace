import { expect, it } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry } from "./index.ts";
import { scope } from "./test-support.ts";

it("agents receive actionable bounded errors while echoed credentials and stacks stay private", async () => {
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  const lease = new CredentialRegistry(() => "a".repeat(64)).issue(
    scope("root", ["browser"]),
    new AbortController().signal,
  );
  class NativeError extends Error {
    readonly code = "target_gone";
    readonly hint = "Take a fresh snapshot";
  }
  registry.registerContent({
    name: "ace_browser_click",
    capability: "browser",
    description: "Click",
    timeoutMs: 1000,
    input: z.strictObject({ ref: z.string() }),
    async run(args) {
      if (args.ref === "plain-error")
        return Promise.reject({
          code: "target_gone",
          message: "Native target disappeared",
          hint: "Refresh tree",
        });
      throw new NativeError(`Element expired; Bearer ${lease.bearer}. ${"x".repeat(5000)}`);
    },
  });
  const call = (args: unknown) =>
    registry.call("ace_browser_click", args, lease.principal, new AbortController().signal);
  const response = await call({ ref: "gone" });
  expect(response.isError).toBe(true);
  const text = response.content?.find((content) => content.type === "text")?.text;
  const failure = z
    .object({ code: z.string(), message: z.string(), hint: z.string() })
    .parse(JSON.parse(String(text)));
  expect(failure).toMatchObject({
    code: "target_gone",
    hint: "Take a fresh snapshot",
    message: expect.stringContaining("Element expired"),
  });
  expect(failure.message.length).toBeLessThanOrEqual(2048);
  expect(JSON.stringify(response)).not.toContain(lease.bearer);
  expect(JSON.stringify(response)).not.toContain("at NativeError");
  expect(await call({ ref: 42 })).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("invalid_arguments") }],
  });
  expect(await call({ ref: "plain-error" })).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("Native target disappeared") }],
  });
  registry.registerContent({
    name: "ace_browser_snapshot",
    capability: "browser",
    description: "Inspect",
    timeoutMs: 1000,
    input: z.strictObject({}),
    async run() {
      z.object({ nodes: z.array(z.unknown()) }).parse({ nodes: "corrupt" });
      return { content: [] };
    },
  });
  expect(
    await registry.call("ace_browser_snapshot", {}, lease.principal, new AbortController().signal),
  ).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("invalid_data") }] });
  lease.end();
});
