import { expect, it } from "vitest";
import { bearer, runtimeFixture } from "./host-runtime-test-support.ts";

// The daemon stores what the host sends as is, so the host must redact the session's MCP bearer
// in every frame body, a Cursor error's included.
it("the session's MCP bearer in a Cursor error or message never reaches ace's storage", async () => {
  const stored: string[] = [];
  const settled = Promise.withResolvers<void>();
  await using fixture = await runtimeFixture(
    {},
    async (envelope) => {
      stored.push(JSON.stringify(envelope));
      if (envelope.kind === "result") settled.resolve();
    },
    {
      message: {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: `lease ${bearer}` }] },
      },
      runError: `MCP call failed with bearer ${bearer}`,
    },
  );
  await fixture.open({ url: "http://127.0.0.1:4321/mcp", bearer });
  await fixture.send("first");
  await settled.promise;
  expect(stored.join("\n")).toContain("MCP call failed");
  expect(stored.join("\n")).not.toContain(bearer);
});
