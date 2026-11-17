import { expect, test } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { Capabilities } from "@ace/protocol";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import { discoverAdapters, settleAll } from "./adapters.ts";
import { AdapterRegistry } from "./registry.ts";

const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
};
const absent: DiscoveryResult = { installed: false, auth: "unknown", loginHint: "" };
const installed: DiscoveryResult = {
  installed: true,
  auth: "unknown",
  loginHint: "",
  path: "/bin/true",
};
function adapter(provider: "claude" | "pi") {
  return createScriptedAdapter({
    provider,
    nativeSessionId: "native-1",
    capabilities: Capabilities.parse({
      steer: false,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: true,
      backgroundTaskControl: true,
      backgroundVisibility: "full",
      planMode: false,
      tokenUsage: false,
      imageInput: false,
      rewindFiles: false,
    }),
    steps: [],
  });
}

test("a provider whose discovery fails early never cuts slower providers short", async () => {
  const clis = Promise.withResolvers<void>();
  const registry = new AdapterRegistry();
  let outcome: unknown;
  const discovering = discoverAdapters(
    async () => {
      await clis.promise;
      return { claude: installed, codex: absent, opencode: absent, cursor: absent };
    },
    () => adapter("claude"),
    async () => {
      throw new Error("Antigravity launch could not be resolved");
    },
    {},
    async () => ({ installed: false, supported: false }),
    registry,
  ).then(
    () => (outcome = "resolved"),
    (error: unknown) => (outcome = error),
  );
  await settle();
  // The caller binds sessions once this settles: it must wait for the slower CLI read.
  expect(outcome).toBeUndefined();

  clis.resolve();
  await discovering;
  expect(registry.has("claude")).toBe(true);
  expect(outcome).toMatchObject({ message: "Antigravity launch could not be resolved" });
});

test("sibling providers both settle before a failure is reported, and each failure is named", async () => {
  const pi = Promise.withResolvers<void>();
  const registry = new AdapterRegistry();
  let outcome: unknown;
  const reading = settleAll([
    Promise.reject(new Error("Antigravity launch could not be resolved")),
    pi.promise.then(() => registry.register(adapter("pi"), installed)),
    Promise.reject(new Error("Cursor SDK unreadable")),
  ]).catch((error: unknown) => (outcome = error));
  await settle();
  expect(outcome).toBeUndefined();

  pi.resolve();
  await reading;
  expect(registry.has("pi")).toBe(true);
  expect(outcome).toMatchObject({
    message: "Antigravity launch could not be resolved; Cursor SDK unreadable",
  });
});
