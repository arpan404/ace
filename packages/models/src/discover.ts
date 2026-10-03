import {
  spawnSupervised,
  type SpawnOptions,
  type SupervisedProcess,
} from "@ace/provider-kit/process";
import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import { z } from "zod";
import { cursorSessionOptions, isMissingMethod } from "./cursor.ts";
import { OpenCodeParser } from "./open-code.ts";
import { CodexPage } from "./native-schemas.ts";
import { normalizeAcp, normalizeClaude, normalizeCodex } from "./normalize.ts";
import type { DiscoverModels, ModelInstance } from "./types.ts";
import type { CatalogModel } from "@ace/protocol";

export type DiscoveryOptions = { spawn?: (options: SpawnOptions) => SupervisedProcess };
const ControlReply = z.object({
  type: z.literal("control_response"),
  response: z.object({
    subtype: z.literal("success"),
    request_id: z.literal("models-init"),
    response: z.unknown(),
  }),
});
function claudeInitialize(proc: SupervisedProcess, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      proc.stdout.removeListener("line", receive);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new Error("Discovery aborted"));
    };
    const receive = (line: string) => {
      try {
        const value: unknown = JSON.parse(line);
        const reply = ControlReply.safeParse(value);
        if (reply.success) {
          cleanup();
          resolve(reply.data.response.response);
        } else if (z.object({ type: z.literal("control_response") }).safeParse(value).success) {
          cleanup();
          reject(new Error("Malformed initialization response"));
        }
      } catch {
        cleanup();
        reject(new Error("Invalid initialization JSON"));
      }
    };
    proc.stdout.on("line", receive);
    signal.addEventListener("abort", abort, { once: true });
    void proc.exited.then(() => {
      cleanup();
      reject(new Error("CLI exited before initialization"));
    });
    proc.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: "models-init",
        request: { subtype: "initialize", hooks: {}, sdkMcpServers: [] },
      }) + "\n",
      (error) => {
        if (error) {
          cleanup();
          reject(error);
        }
      },
    );
  });
}
export function createModelDiscovery(options: DiscoveryOptions = {}): DiscoverModels {
  const spawn = options.spawn ?? spawnSupervised;
  return async (instance: ModelInstance, signal: AbortSignal): Promise<CatalogModel[]> => {
    signal.throwIfAborted();
    // Unprofiled session/new is executable startup behavior, not a metadata query.
    if (instance.provider === "acp") return [];
    const args = [...instance.args];
    switch (instance.provider) {
      case "codex":
        args.push("app-server");
        break;
      case "claude":
        args.push(
          "--print",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--setting-sources",
          "",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
        );
        break;
      case "opencode":
        args.push("models", "--verbose");
        break;
      case "cursor":
        args.push("acp");
        break;
      case "antigravity":
        break;
    }
    const proc = spawn({
      command: instance.executable,
      args,
      cwd: instance.cwd,
      env: instance.env,
      name: "model-discovery",
      maxOutputBytes: 4 * 1024 * 1024,
    });
    const abort = () => {
      void proc.stop({ graceMs: 0 });
    };
    signal.addEventListener("abort", abort, { once: true });
    let rpc: JsonRpcPeer | undefined;
    async function readModels(): Promise<CatalogModel[]> {
      if (instance.provider === "claude")
        return normalizeClaude(await claudeInitialize(proc, signal), instance);
      if (instance.provider === "opencode") {
        const parser = new OpenCodeParser(instance);
        let failure: unknown;
        const receive = (line: string) => {
          try {
            parser.push(line);
          } catch (error) {
            failure = error;
            proc.stdout.removeListener("line", receive);
            void proc.stop({ graceMs: 0 });
          }
        };
        proc.stdout.on("line", receive);
        try {
          const exit = await proc.exited;
          signal.throwIfAborted();
          if (failure) throw failure;
          if (exit.code !== 0) throw new Error("Model listing failed");
          return parser.finish();
        } finally {
          proc.stdout.removeListener("line", receive);
        }
      }
      rpc = new JsonRpcPeer(proc, { timeoutMs: null });
      if (instance.provider === "codex") {
        await rpc.request(
          "initialize",
          {
            clientInfo: { name: "ace_models", title: "ace models", version: "0.0.0" },
            capabilities: { experimentalApi: true },
          },
          { signal },
        );
        rpc.notify("initialized");
        const models: CatalogModel[] = [];
        let cursor: string | undefined;
        const cursors = new Set<string>();
        for (let page = 0; page < 64; page++) {
          const payload = CodexPage.parse(
            await rpc.request(
              "model/list",
              { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) },
              { signal },
            ),
          );
          models.push(...normalizeCodex(payload, instance));
          if (models.length > 512) throw new Error("Too many models");
          if (!payload.nextCursor) return models;
          cursor = payload.nextCursor;
          if (cursors.has(cursor)) throw new Error("Repeated model cursor");
          cursors.add(cursor);
        }
        throw new Error("Model pagination limit reached");
      }
      const initialized = z
        .object({ protocolVersion: z.literal(1) })
        .passthrough()
        .parse(
          await rpc.request(
            "initialize",
            {
              protocolVersion: 1,
              clientInfo: { name: "ace_models", version: "0.0.0" },
              clientCapabilities: { _meta: { parameterizedModelPicker: true } },
            },
            { signal },
          ),
        );
      void initialized;
      const session = await rpc.request(
        "session/new",
        { cwd: instance.cwd, mcpServers: [] },
        { signal },
      );
      if (instance.provider === "cursor") {
        let listing: unknown;
        try {
          listing = await rpc.request("cursor/list_available_models", {}, { signal });
        } catch (error) {
          if (!isMissingMethod(error)) throw error;
        }
        if (listing !== undefined)
          return normalizeAcp(cursorSessionOptions(session, listing), instance);
      }
      return normalizeAcp(session, instance);
    }
    try {
      const rows = await readModels();
      const exit = await proc.stop({ graceMs: 0 });
      if (exit.reason === "output-limit") throw new Error("Model metadata output exceeded limit");
      signal.throwIfAborted();
      return rows;
    } finally {
      rpc?.close();
      signal.removeEventListener("abort", abort);
      await proc.stop({ graceMs: 0 });
    }
  };
}
