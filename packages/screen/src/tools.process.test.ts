import { expect, it } from "vitest";
import { z } from "zod";
import { computerUseTools, computerUseHandler } from "./index.ts";
import { manager, ready } from "./testing/support.ts";
it("the advertised text schema and handler accept the same bounded input", async () => {
  const definition = computerUseTools.find((tool) => tool.name === "screen_type");
  if (!definition) throw new Error("Missing typing tool");
  const input = z.fromJSONSchema(definition.inputSchema);
  const test = await manager();
  try {
    const state = await ready(test.screen);
    test.screen.controller(state.sessionId, "agent", "caller");
    const handler = computerUseHandler(test.screen, state.sessionId, "caller");
    const accepted = { text: "x".repeat(4096) };
    expect(input.parse(accepted)).toEqual(accepted);
    await expect(handler("screen_type", accepted)).resolves.toMatchObject({
      content: [{ text: "Action completed" }],
    });
    const rejected = { text: "x".repeat(4097) };
    expect(() => input.parse(rejected)).toThrow();
    await expect(handler("screen_type", rejected)).rejects.toThrow();
  } finally {
    await test.close();
  }
});
