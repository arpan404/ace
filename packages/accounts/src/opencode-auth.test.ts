import { expect, test } from "vitest";
import { openCodeAuthChangeVerified, openCodeIntegrationConnected } from "./index.ts";

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

test("an untargeted OpenCode logout succeeds when connections shrink, even with one remaining", () => {
  const before = new Map([
    ["github-copilot", 1],
    ["anthropic", 1],
  ]);
  const after = new Map([
    ["github-copilot", 0],
    ["anthropic", 1],
  ]);
  expect(openCodeAuthChangeVerified("logout", "other", before, after)).toBe(true);
  expect(openCodeAuthChangeVerified("logout", undefined, before, after)).toBe(true);
  expect(openCodeAuthChangeVerified("logout", "other", before, before)).toBe(false);
});

test("an untargeted OpenCode logout without a before snapshot still requires a full disconnect", () => {
  expect(openCodeAuthChangeVerified("logout", "other", undefined, new Map())).toBe(true);
  expect(
    openCodeAuthChangeVerified("logout", "other", undefined, new Map([["anthropic", 1]])),
  ).toBe(false);
});

test("targeted OpenCode verification still checks only the chosen integration", () => {
  const after = new Map([
    ["openai", 0],
    ["anthropic", 1],
  ]);
  expect(openCodeAuthChangeVerified("login", "anthropic", undefined, after)).toBe(true);
  expect(openCodeAuthChangeVerified("login", "openai", undefined, after)).toBe(false);
  expect(openCodeAuthChangeVerified("logout", "openai", undefined, after)).toBe(true);
  expect(openCodeAuthChangeVerified("logout", "anthropic", undefined, after)).toBe(false);
});
