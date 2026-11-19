import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { discoverProviders, type DiscoveryResult, type Provider } from "./discovery/index.ts";
import { JsonRpcPeer } from "./jsonrpc.ts";
import { spawnSupervised, type SupervisedProcess } from "./process.ts";
import { PROCESS_TEST_TIMEOUT } from "./testing/cli.ts";

const processes: SupervisedProcess[] = [];
let discovery: Record<Provider, DiscoveryResult>;
function launch(provider: Provider, args: string[], env: NodeJS.ProcessEnv = {}) {
  const command = discovery[provider].path;
  if (!command) throw new Error(`${provider} not installed`);
  const proc = spawnSupervised({ command, args, env, name: `live-${provider}` });
  processes.push(proc);
  return proc;
}
afterEach(async () => {
  await Promise.all(processes.splice(0).map((proc) => proc.stop({ graceMs: 5000 })));
});

/** Handshakes only. Never create sessions, authenticate, or send prompts. */
describe.skipIf(process.env["ACE_LIVE_CLI"] !== "1")(
  "installed CLI handshakes (no sessions or prompts)",
  () => {
    beforeAll(async () => {
      discovery = await discoverProviders({ timeoutMs: 30_000 });
      console.info(
        "Live discovery: " +
          Object.entries(discovery)
            .map(
              ([provider, result]) =>
                `${provider} ${result.version ?? "unavailable"} ${result.auth}${result.authEvidence ? " " + result.authEvidence : ""}`,
            )
            .join("; "),
      );
    }, PROCESS_TEST_TIMEOUT);
    it("discovers a version and read-only auth status for every installed CLI", () => {
      for (const result of Object.values(discovery)) {
        if (!result.installed) continue;
        expect(result.version).toBeTruthy();
        expect(result.auth).not.toBe("unknown");
        expect(result.error).toBeUndefined();
      }
    });
    it("Codex app-server initializes over stdio without starting a thread", async (ctx) => {
      if (!discovery.codex.installed) ctx.skip();
      const proc = launch("codex", ["app-server"]);
      const errors: Error[] = [];
      const rpc = new JsonRpcPeer(proc, { onError: (error) => errors.push(error) });
      const result = await rpc.request(
        "initialize",
        {
          clientInfo: { name: "ace_provider_kit_smoke", version: "0.0.0" },
          capabilities: { experimentalApi: true },
        },
        { timeoutMs: 30_000 },
      );
      expect(result).toMatchObject({ userAgent: expect.any(String) });
      rpc.notify("initialized");
      // A write callback after the notification proves the stdio queue drained.
      await new Promise<void>((resolve, reject) =>
        proc.stdin.write("", (error) => (error ? reject(error) : resolve())),
      );
      expect(errors).toEqual([]);
      await proc.stop({ graceMs: 5000 });
      console.info("Live Codex: initialize + initialized; stopped");
    });
  },
);
