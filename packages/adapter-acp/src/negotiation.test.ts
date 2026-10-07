import { expect, test } from "vitest";
import { negotiate, genericQuirks } from "./index.ts";
test("a registered ACP version change requires a new installation plan", () => {
  const response = {
    protocolVersion: 1,
    agentInfo: { name: "synthetic", version: "2.0.0" },
    agentCapabilities: { loadSession: true },
  };
  expect(() => negotiate(response, genericQuirks, "1.0.0")).toThrow("new installation plan");
});
