import { expect, test } from "vitest";
import { machineSecrets, forgetMachineTokens } from "./machine-secrets.ts";
import { memoryKeyValue } from "@/test/harness.tsx";

test("machine access lasts for the session unless remembering is explicit, and Disconnect clears both stores", async () => {
  const local = memoryKeyValue();
  const session = memoryKeyValue();
  const secrets = machineSecrets(local, session);
  await secrets.set("session", "a".repeat(64));
  await secrets.set("remembered", "b".repeat(64), true);
  expect([...local.data.values()].join("")).not.toContain("a".repeat(64));
  expect(await machineSecrets(local, memoryKeyValue()).get("session")).toBeNull();
  expect(await machineSecrets(local, memoryKeyValue()).get("remembered")).toBe("b".repeat(64));
  forgetMachineTokens(local, session);
  expect(await secrets.get("session")).toBeNull();
  expect(await secrets.get("remembered")).toBeNull();
});

test("Disconnect also clears machine tokens written before the secret index existed", async () => {
  const local = memoryKeyValue();
  const session = memoryKeyValue();
  const key = JSON.stringify(["old-host", "old-device"]);
  local.setItem(
    "ace.machines",
    JSON.stringify({ version: 1, machines: [{ hostId: "old-host", deviceId: "old-device" }] }),
  );
  local.setItem(`ace.machines.token.${key}`, "c".repeat(64));
  forgetMachineTokens(local, session);
  expect(await machineSecrets(local, session).get(key)).toBeNull();
  expect(local.getItem("ace.machines")).toContain("old-host");
});
