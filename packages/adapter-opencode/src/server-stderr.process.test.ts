import { expect, it } from "vitest";
import { setup } from "./testing/v2-session.ts";

// OpenCode passes its MCP servers' stderr through; one long log line must not stop the server.
it("the shared OpenCode server survives an oversized stderr line and keeps serving sessions", async () => {
  const h = await setup({ discovery: { env: { ACE_TEST_STDERR_LINE_BYTES: "131072" } } });
  const second = await h.open("/two");
  expect(second.nativeSessionId).not.toBe(h.session.nativeSessionId);
  expect(h.exits).toEqual([]);
});
