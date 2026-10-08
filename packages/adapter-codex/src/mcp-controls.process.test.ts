import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";

test("Codex MCP controls reload failed servers and disable or enable them through provider config", async () => {
  const h = await sessionHarness();
  try {
    const controls = h.session.mcp;
    if (!controls) throw new Error("No MCP controls");
    expect(await controls.status()).toEqual([{ name: "docs", status: "failed" }]);
    await controls.reconnect("docs");
    expect(await controls.status()).toEqual([{ name: "docs", status: "connected" }]);
    await controls.disable("docs");
    expect(await controls.status()).toEqual([{ name: "docs", status: "disabled" }]);
    await controls.enable("docs");
    expect(await controls.status()).toEqual([{ name: "docs", status: "connected" }]);
    await controls.add?.("issues", { transport: "http", url: "http://127.0.0.1:9999/mcp" });
    expect(await controls.status()).toEqual([
      { name: "docs", status: "connected" },
      { name: "issues", status: "connected" },
    ]);
  } finally {
    await h.dispose();
  }
});
