const selectorSetup = (values: string[]) => ({
  configOptions: [
    {
      id: "actual-selector",
      type: "select",
      category: "model",
      options: values.map((value) => ({ value, name: value })),
    },
  ],
});
import { expect, test } from "vitest";
import {
  decodeIndex,
  availability,
  buildInstallPlan,
  platformTarget,
  digest,
  accountIsolation,
  accountMigration,
  sessionSelectors,
  selectorRequest,
  matchProfile,
} from "./index.ts";
const entry = {
  id: "sample",
  name: "Sample",
  version: "1.2.3",
  description: "Synthetic ACP agent",
  license_url: "https://example.org/license",
  distribution: {
    npx: { package: "sample@1.2.3", args: ["--acp"], env: { NO_UPDATE: "1" } },
    future: { opaque: true },
  },
  custom: { retained: true },
};
const decode = (agents: unknown[], version = "1.0.0") =>
  decodeIndex(Buffer.from(JSON.stringify({ version, agents })));
test("additive registry metadata survives while future-only distributions stay unavailable", () => {
  const agent = decode([{ ...entry, distribution: { future: { opaque: true } } }]).agents[0];
  if (!agent) throw new Error("Missing sample");
  expect(agent.custom).toEqual({ retained: true });
  expect(agent.distribution.future).toEqual({ opaque: true });
  expect(availability(agent, "darwin-aarch64")).toBe("unsupported_distribution");
  expect(() =>
    buildInstallPlan({
      agent,
      acpAgentId: "official:sample",
      source: "https://example.org/registry",
      catalogDigest: digest("snapshot"),
      target: "darwin-aarch64",
      root: "/tmp/artifacts",
      runtime: "binary",
    }),
  ).toThrow();
});
test("duplicate identifiers, future schema majors and oversized entries reject an entire refresh", () => {
  expect(() => decode([entry, entry])).toThrow();
  expect(() => decode([entry], "2.0.0")).toThrow();
  expect(() => decode([{ ...entry, opaque: "x".repeat(65536) }])).toThrow();
  expect(() => decodeIndex(Buffer.alloc(4 * 1024 * 1024 + 1))).toThrow();
});
test("installation plans pin the upstream version and change when the artifact changes", () => {
  const agent = decode([entry]).agents[0];
  if (!agent) throw new Error("Missing sample");
  const options = {
    agent,
    acpAgentId: "official:sample",
    source: "https://example.org/registry",
    catalogDigest: digest("snapshot"),
    target: "linux-x86_64",
    root: "/tmp/artifacts",
    runtime: "npm" as const,
    manager: "/usr/local/bin/npm",
  };
  const first = buildInstallPlan(options);
  expect(first.preview.argv).toContain("sample@1.2.3");
  expect(first.preview.verification).toBe("package_manager");
  expect(
    buildInstallPlan({
      ...options,
      agent: {
        ...agent,
        distribution: { npx: { package: "sample@1.2.4", args: [], env: {} } },
        version: "1.2.4",
      },
    }).preview.digest,
  ).not.toBe(first.preview.digest);
  expect(() =>
    buildInstallPlan({
      ...options,
      agent: { ...agent, distribution: { npx: { package: "sample@latest", args: [], env: {} } } },
    }),
  ).toThrow("pinned");
});
test("binary command escapes and unsupported platforms never form executable plans", () => {
  expect(platformTarget("darwin", "arm64")).toBe("darwin-aarch64");
  expect(platformTarget("linux", "riscv64")).toBeUndefined();
  const agent = decode([
    {
      ...entry,
      distribution: {
        binary: { "darwin-aarch64": { archive: "https://example.org/a.tgz", cmd: "../escape" } },
      },
    },
  ]).agents[0];
  if (!agent) throw new Error("Missing sample");
  const options = {
    agent,
    acpAgentId: "official:sample",
    source: "https://example.org/registry",
    catalogDigest: digest("a"),
    target: "darwin-aarch64",
    root: "/tmp/artifacts",
    runtime: "binary" as const,
  };
  expect(() => buildInstallPlan(options)).toThrow("Unsafe");
  expect(() => buildInstallPlan({ ...options, target: "linux-x86_64" })).toThrow("unavailable");
});
test("model selection uses the advertised config ID and rejects removed dependent choices", () => {
  const selectors = sessionSelectors(selectorSetup(["native-a", "native-b"]));
  expect(selectorRequest(selectors, "model", "native-b", "session")).toEqual({
    method: "session/set_config_option",
    params: { sessionId: "session", configId: "actual-selector", value: "native-b" },
  });
  expect(() =>
    selectorRequest(sessionSelectors(selectorSetup(["native-a"])), "model", "native-b", "session"),
  ).toThrow("unavailable");
});
test("old Qwen blocks setters while Gemini uses its legacy dialect and generic modes use standard ACP", () => {
  const setup = {
    models: { availableModels: [{ modelId: "native", name: "Native" }] },
    modes: { availableModes: [{ id: "plan", name: "Plan" }] },
  };
  expect(() =>
    selectorRequest(
      sessionSelectors(setup, matchProfile("qwen-code", "0.0.14")),
      "model",
      "native",
      "s",
    ),
  ).toThrow();
  expect(() => selectorRequest(sessionSelectors(setup), "model", "native", "s")).toThrow();
  expect(
    selectorRequest(
      sessionSelectors(setup, matchProfile("gemini", "0.43.0")),
      "model",
      "native",
      "s",
    ).method,
  ).toBe("session/set_model");
  expect(selectorRequest(sessionSelectors(setup), "mode", "plan", "s")).toEqual({
    method: "session/set_mode",
    params: { sessionId: "s", modeId: "plan" },
  });
  expect(matchProfile("qwen-code", "0.24.7")?.args).toEqual(["--acp"]);
  expect(matchProfile("gemini", "0.62.0")).toBeUndefined();
  expect(accountIsolation().supported).toBe(false);
  expect(accountMigration().supported).toBe(false);
});
