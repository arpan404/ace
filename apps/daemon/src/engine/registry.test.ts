import { expect, test } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { AdapterRegistry } from "./registry.ts";

const adapter = () =>
  createScriptedAdapter({
    provider: "opencode",
    capabilities: {
      steer: false,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: false,
      backgroundTaskControl: false,
      backgroundVisibility: "none",
      planMode: false,
      tokenUsage: false,
      imageInput: false,
      rewindFiles: false,
    },
    createTranslator: () => ({ translate: () => [], tick: () => [] }),
    steps: [],
  });
const located = {
  installed: true,
  path: "/bin/opencode",
  version: "2.3.0",
  auth: "unknown" as const,
  loginHint: "opencode auth login",
};

test("a CLI's login read after its adapter registered is what the registry reports", () => {
  const registry = new AdapterRegistry();
  registry.register(adapter(), located);
  registry.refreshDiscovery("opencode", { ...located, auth: "logged_out" });
  expect(registry.get("opencode").discovery.auth).toBe("logged_out");
});

test("a reading of another executable or version leaves the registered CLI's facts alone", () => {
  const registry = new AdapterRegistry();
  registry.register(adapter(), located);
  registry.refreshDiscovery("opencode", { ...located, path: "/opt/opencode", auth: "logged_in" });
  registry.refreshDiscovery("opencode", { ...located, version: "2.4.0", auth: "logged_in" });
  registry.refreshDiscovery("opencode", { ...located, installed: false, auth: "logged_in" });
  expect(registry.get("opencode").discovery.auth).toBe("unknown");
});

test("a login read for a provider with no adapter registers nothing", () => {
  const registry = new AdapterRegistry();
  registry.refreshDiscovery("opencode", { ...located, auth: "logged_in" });
  expect(registry.has("opencode")).toBe(false);
});
