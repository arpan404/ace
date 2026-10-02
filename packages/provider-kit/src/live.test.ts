import { createServer } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { discoverProviders, type DiscoveryResult, type Provider } from "./discovery/index.ts";
import { JsonRpcPeer } from "./jsonrpc.ts";
import { spawnSupervised, type SupervisedProcess } from "./process.ts";
import { readSse } from "./sse.ts";

const processes: SupervisedProcess[] = [];
const streams: AbortController[] = [];
let discovery: Record<Provider, DiscoveryResult>;
function launch(provider: Provider, args: string[], env: NodeJS.ProcessEnv = {}) {
  const command = discovery[provider].path;
  if (!command) throw new Error(`${provider} not installed`);
  const proc = spawnSupervised({ command, args, env, name: `live-${provider}` });
  processes.push(proc);
  return proc;
}
afterEach(async () => {
  streams.splice(0).forEach((stream) => stream.abort());
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
    }, 60_000);
    it("discovers a version and read-only auth status for every installed CLI", () => {
      for (const result of Object.values(discovery)) {
        if (!result.installed) continue;
        expect(result.version).toBeTruthy();
        expect(result.auth).not.toBe("unknown");
        expect(result.error).toBeUndefined();
      }
    });
    it("OpenCode global SSE emits connected and heartbeat without creating a session", async (ctx) => {
      if (!discovery.opencode.installed) ctx.skip();
      const password = randomBytes(24).toString("base64url");
      const reservation = createServer();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      const address = reservation.address();
      if (!address || typeof address === "string") throw new Error("No ephemeral port");
      const port = String(address.port);
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
      const proc = launch("opencode", ["serve", "--hostname", "127.0.0.1", "--port", port], {
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      });
      const listening = new Promise<string>((resolve, reject) => {
        proc.stdout.on("line", (line) => {
          const url = /listening on (http:\/\/\S+)/.exec(line)?.[1];
          if (url) resolve(url);
        });
        void proc.exited.then(() => reject(new Error("OpenCode ended before listen URL")));
      });
      const base = await listening;
      const abort = new AbortController();
      streams.push(abort);
      const received: string[] = [];
      await readSse(new URL("/global/event", base), {
        signal: abort.signal,
        reconnect: false,
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        },
        onEvent: ({ data }) => {
          const event: unknown = JSON.parse(data);
          if (typeof event !== "object" || !event) return;
          const payload = (event as { payload?: { type?: unknown } }).payload;
          if (typeof payload?.type === "string") received.push(payload.type);
          if (received.includes("server.connected") && received.includes("server.heartbeat"))
            abort.abort();
        },
      });
      expect(received).toEqual(expect.arrayContaining(["server.connected", "server.heartbeat"]));
      const exit = await proc.stop({ graceMs: 5000 });
      expect(exit.reason).toBe("stopped");
      console.info("Live OpenCode: connected + heartbeat; stopped");
    }, 60_000);
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
    }, 60_000);
    it("Cursor ACP initializes without creating a session", async (ctx) => {
      if (!discovery.cursor.installed) ctx.skip();
      const proc = launch("cursor", ["acp"]);
      const rpc = new JsonRpcPeer(proc);
      const result = await rpc.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "ace-provider-kit-smoke", version: "0.0.0" },
        },
        { timeoutMs: 30_000 },
      );
      expect(result).toMatchObject({ protocolVersion: 1 });
      await proc.stop({ graceMs: 5000 });
      console.info("Live Cursor: initialize; stopped");
    }, 60_000);
  },
);
