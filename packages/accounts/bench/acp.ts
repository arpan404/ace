// Informational public account lookup workload. Execution deferred to the merge gate.
import { DatabaseSync } from "node:sqlite";
import { AccountRegistry, AccountService, createAcpInstance } from "../src/index.ts";
import { AcpIdentity } from "@ace/protocol";
const registry = new AccountRegistry(new DatabaseSync(":memory:"));
const identity = AcpIdentity.parse({
  acpAgentId: "local:benchmark",
  installationId: "approved",
  instanceId: "approved:default",
});
await registry.register(
  createAcpInstance({ identity, label: "Synthetic", userHome: process.cwd() }),
);
const accounts = new AccountService({ registry, env: {}, now: () => 1, timeZone: "UTC" });
const iterations = 100000;
const start = performance.now();
for (let index = 0; index < iterations; index++) accounts.acpEnvironment(identity);
const ms = performance.now() - start;
process.stdout.write(
  `${JSON.stringify({ name: "acp-account-environment", opsPerSecond: (iterations * 1000) / ms, microsecondsPerOp: (ms * 1000) / iterations, peakRssKiB: process.resourceUsage().maxRSS, runtime: process.version })}\n`,
);
registry.close();
