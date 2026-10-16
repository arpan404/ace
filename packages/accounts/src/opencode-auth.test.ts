import { expect, test } from "vitest";
import { openCodeIntegrationConnected } from "./index.ts";

test("another connected service cannot make the selected OpenCode login succeed", () => {
  const connections = new Map([
    ["openai", 0],
    ["anthropic", 1],
  ]);
  expect(openCodeIntegrationConnected(connections, "openai")).toBe(false);
  expect(openCodeIntegrationConnected(connections, "anthropic")).toBe(true);
  expect(openCodeIntegrationConnected(connections, "opencode-go")).toBe(false);
});

test("disconnecting one OpenCode service can be confirmed while another remains connected", () => {
  const before = new Map([
    ["openai", 2],
    ["anthropic", 1],
  ]);
  const after = new Map([["anthropic", 1]]);
  expect(openCodeIntegrationConnected(before, "openai")).toBe(true);
  expect(openCodeIntegrationConnected(after, "openai")).toBe(false);
  expect(openCodeIntegrationConnected(after, "anthropic")).toBe(true);
});

test("an untargeted OpenCode picker reports configured only while some connection remains", () => {
  expect(openCodeIntegrationConnected(new Map([["custom", 1]]), "other")).toBe(true);
  expect(openCodeIntegrationConnected(new Map([["custom", 0]]), "other")).toBe(false);
});
