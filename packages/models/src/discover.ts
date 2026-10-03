import { CursorHostSlots } from "@ace/adapter-cursor";
import { discoverClaudeModels } from "@ace/adapter-claude";
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
import { normalizeAcp, normalizeClaude, normalizeCodex, normalizeCursorSdk } from "./normalize.ts";
import type { DiscoverModels, ModelInstance } from "./types.ts";
import type { CatalogModel } from "@ace/protocol";

export type DiscoveryOptions = {
  spawn?: (options: SpawnOptions) => SupervisedProcess;
  cursorSlots?: CursorHostSlots;
  /** Selected launch environment stays local to supervised SDK workers, never catalog rows. */
  cursorEnv?: NodeJS.ProcessEnv;
  cursorEnvironment?(instance: ModelInstance): NodeJS.ProcessEnv;
};
export function createModelDiscovery(options: DiscoveryOptions = {}): DiscoverModels {
  const spawn = options.spawn ?? spawnSupervised;
  const cursorSlots = options.cursorSlots ?? new CursorHostSlots(2);
  return async (instance: ModelInstance, signal: AbortSignal): Promise<CatalogModel[]> => {
    signal.throwIfAborted();
    if (instance.backend === "cursor-sdk") {
      const { createCursorAccountDriver } = await import("@ace/adapter-cursor");
      if (!instance.homeDir) throw new Error("Cursor SDK catalog needs its selected instance home");
      const driver = createCursorAccountDriver({
        launchEnv: { ...options.cursorEnv, ...instance.env },
        slots: cursorSlots,
        ...(options.cursorEnvironment
          ? { environment: () => options.cursorEnvironment?.(instance) ?? {} }
          : {}),
        ...(options.spawn ? { spawn: options.spawn } : {}),
        stopInstance: async () => {
          throw new Error("Catalog worker cannot sign out live sessions");
        },
      });
      return normalizeCursorSdk(
        await driver.models({ id: instance.id, homeDir: instance.homeDir }, signal),
        instance,
      );
    }
    if (instance.provider === "claude")
      return normalizeClaude(
        await discoverClaudeModels({
          executable: instance.executable,
          args: instance.args,
          cwd: instance.cwd,
          env: instance.env,
          signal,
          spawn,
        }),
        instance,
      );
    const args = [...instance.args];
    switch (instance.provider) {
      case "codex":
        args.push("app-server");
        break;
      case "opencode":
        args.push("models", "--verbose");
        break;
      case "cursor":
        args.push("acp");
        break;
      case "acp":
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
