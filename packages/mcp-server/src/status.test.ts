import { expect, test } from "vitest";
import { mcpStatusGroups } from "./status.ts";

test("an off group says why: not running, not offered here, or the server's own reasons", () => {
  const registered = new Set(["agents", "thread_control"] as const);
  const defaults = mcpStatusGroups(registered, ["agents"]);
  expect(defaults).toContainEqual({
    name: "browser",
    enabled: false,
    reason: "This ace daemon is not running this tool group.",
  });
  expect(defaults).toContainEqual({
    name: "thread_control",
    enabled: false,
    reason: "ace does not offer this tool group to this provider session.",
  });
  expect(defaults).toContainEqual({ name: "agents", enabled: true });
  const external = mcpStatusGroups(registered, [], undefined, {
    unregistered: "Not offered to external MCP clients.",
    withheld: "This enrollment is read-only.",
  });
  expect(external).toContainEqual({
    name: "browser",
    enabled: false,
    reason: "Not offered to external MCP clients.",
  });
  expect(external).toContainEqual({
    name: "agents",
    enabled: false,
    reason: "This enrollment is read-only.",
  });
  // A group a person turned off keeps that reason over either default.
  expect(
    mcpStatusGroups(registered, ["agents"], { agents: "Off in settings." }, {}),
  ).toContainEqual({ name: "agents", enabled: false, reason: "Off in settings." });
});
