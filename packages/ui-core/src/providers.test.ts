import { expect, test } from "vitest";
import { providerDisplayName } from "./providers.ts";

test("Antigravity's ACP login is named Antigravity, matching its provider, not antigravity-acp", () => {
  expect(providerDisplayName("acp", "official:antigravity-acp")).toBe("Antigravity");
  expect(providerDisplayName("antigravity")).toBe("Antigravity");
});

test("an ACP agent known to the registry shows its registry name under any of its ids", () => {
  expect(providerDisplayName("acp", "official:gemini")).toBe("Gemini CLI");
  expect(providerDisplayName("acp", "local:Gemini CLI")).toBe("Gemini CLI");
});

test("an ACP agent the registry doesn't know falls back to its id without the source prefix", () => {
  expect(providerDisplayName("acp", "local:my-agent")).toBe("my-agent");
});
