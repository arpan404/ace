import type { RegistryInstallPlan } from "@ace/protocol";
import { expect, test } from "vitest";
import { planCommand, registryFailure, registrySetup, registryPublisher } from "./acp-registry.ts";

test("a registry login hint becomes a command to run, what to type after it, or plain words", () => {
  expect(registrySetup("codex login")).toEqual({ run: "codex login" });
  expect(registrySetup("claude, then /login")).toEqual({ run: "claude", prompt: "/login" });
  expect(registrySetup("qwen: configure a CLI-owned provider")).toEqual({
    run: "qwen",
    note: "configure a CLI-owned provider",
  });
  expect(registrySetup("Use the agent CLI's own login or configuration command")).toEqual({
    note: "Use the agent CLI's own login or configuration command",
  });
});

const plan = (fields: Partial<RegistryInstallPlan>): RegistryInstallPlan => ({
  digest: "a".repeat(64),
  acpAgentId: "official:sample",
  version: "1.0.0",
  source: "https://cdn.example.org/registry.json",
  publisher: ["Sample"],
  runtime: "npm",
  target: "darwin-aarch64",
  destination: "/Users/ada/My Agents/abc",
  argv: [],
  verification: "package_manager",
  ...fields,
});

test("the command shown is exactly what runs, quoted where a shell would need it", () => {
  expect(
    planCommand(
      plan({
        argv: ["/opt/bin/npm", "install", "--prefix", "/Users/ada/My Agents/abc", "--", "x@1.0.0"],
      }),
    ),
  ).toBe("/opt/bin/npm install --prefix '/Users/ada/My Agents/abc' -- x@1.0.0");
  expect(
    planCommand(
      plan({ runtime: "binary", argv: ["https://example.org/a.zip", "./bin/agent", "acp"] }),
    ),
  ).toBe("'/Users/ada/My Agents/abc/bin/agent' acp");
});

test("daemon refusals read as fixed words; anything unrecognised never echoes its text", () => {
  expect(registryFailure("Installation cancelled")).toBe(
    "Installation cancelled. Nothing was changed.",
  );
  expect(registryFailure("Agent registry unavailable")).toBe(
    "This daemon can't install from the ACP registry yet.",
  );
  expect(registryFailure("npm ERR! token=secret")).toBe("That didn't work. Try again.");
});

test("registry publishers show names and omit contact addresses or opaque handles", () => {
  expect(registryPublisher(["Google", "Anthropic <team@example.invalid>", "Zed Industries"])).toBe(
    "Google, Anthropic, Zed Industries",
  );
  expect(registryPublisher(["tao12345666333", "enquiries@fast-agent.ai", "unknown_handle"])).toBe(
    "",
  );
});
