import { expect, test } from "vitest";
import { negotiate, genericQuirks, cursorQuirks } from "./index.ts";
test("a registered ACP version change requires a new plan while Cursor keeps its installed CLI dialect", () => {
  const response = {
    protocolVersion: 1,
    agentInfo: { name: "synthetic", version: "2.0.0" },
    agentCapabilities: { loadSession: true },
  };
  expect(() => negotiate(response, genericQuirks, "1.0.0")).toThrow("new installation plan");
  expect(negotiate(response, cursorQuirks, "2026.09.26-dd393fe").capabilities.resume).toBe(true);
});
