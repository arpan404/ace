import { discoveredModels, withPermissionModes } from "./discovered-models.ts";
import { acpPermissionModes } from "@ace/provider-kit/permission-modes";
import { withPerModelOptions } from "./acp-model-probe.ts";
import { CursorHostSlots } from "@ace/adapter-cursor/slots";
import { discoverClaudeModels } from "@ace/adapter-claude/models";
import {
  spawnSupervised,
  type SpawnOptions,
  type SupervisedProcess,
} from "@ace/provider-kit/process";
import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import {
  findInstalledExecutable,
  VersionManagerToolMissingError,
} from "@ace/provider-kit/discovery";
import { openWithSignIn } from "@ace/provider-kit/acp-sign-in";
import { z } from "zod";
import { discoverListedModels } from "./list-discovery.ts";
import { discoverOpenCodeCatalog } from "./opencode-discovery.ts";
import { CodexPage } from "./native-schemas.ts";
import { normalizeAcp, normalizeClaude, normalizeCodex, normalizeCursorSdk } from "./normalize.ts";
import type { DiscoverModels, ModelInstance } from "./types.ts";
import type { CatalogModel } from "@ace/protocol";

const InitializeReply = z.object({ protocolVersion: z.literal(1) }).passthrough();
/** How an ACP agent's metadata-only probe runs, resolved by its owner when the probe starts. */
export type AcpProbeLaunch = {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** A folder the probe's session opens in: ace's own neutral one, never a project. */
  cwd: string;
  /**
   * `needs-session`: the agent hides modes in this folder (Gemini in a folder it does not
   * trust), so the probe's modes are not the agent's and are not kept.
   */
  modes: "reported" | "needs-session";
};
export type DiscoveryOptions = {
  /**
   * Launches an ACP agent's probe: initialize and session/new, never a prompt, then the process
   * stops. Without it, ACP rows load only from their sessions.
   */
  acpProbe?(instance: ModelInstance, signal: AbortSignal): Promise<AcpProbeLaunch>;
  spawn?: (options: SpawnOptions) => SupervisedProcess;
  cursorSlots?: CursorHostSlots;
  /** Selected launch environment stays local to supervised SDK workers, never catalog rows. */
  cursorEnv?: NodeJS.ProcessEnv;
  cursorEnvironment?(instance: ModelInstance): NodeJS.ProcessEnv;
  opencode?: (instance: ModelInstance, signal: AbortSignal) => Promise<unknown>;
};
/**
 * The instance with the binary listing its models may run. Listing models starts the CLI, and a
 * version manager's shim can install or update its tool when it starts, so a shim runs as the
 * installed binary its manager names, and never itself.
 */
async function launchable(instance: ModelInstance, signal: AbortSignal): Promise<ModelInstance> {
  if (instance.provider === "cursor" || instance.provider === "acp") return instance;
  const found = await findInstalledExecutable(
    instance.executable,
    { ...process.env, ...instance.env },
    // The catalog runs the CLI in the instance's directory: resolve its version there too.
    { signal, cwd: instance.cwd },
  );
  if (!found) return instance;
  if ("refused" in found) throw found.refused;
  if ("absent" in found) throw new VersionManagerToolMissingError(found.path);
  return found.run === found.path ? instance : { ...instance, executable: found.run };
}

export function createModelDiscovery(options: DiscoveryOptions = {}): DiscoverModels {
  const spawn = options.spawn ?? spawnSupervised;
  const cursorSlots = options.cursorSlots ?? new CursorHostSlots(2);
  return async (requested, signal, diagnostic): ReturnType<DiscoverModels> => {
    signal.throwIfAborted();
    const instance = await launchable(requested, signal);
    if (instance.provider === "cursor") {
      const { createCursorAccountDriver } = await import("@ace/adapter-cursor/auth");
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
        await driver.models({ id: instance.id, homeDir: instance.homeDir }, signal, diagnostic),
        instance,
        (entry) => diagnostic?.({ rejectedModels: [entry] }),
      );
    }
    // The catalog decides when an ACP agent may be probed (`acp-probe-gate.ts`).
    const acp =
      instance.provider === "acp"
        ? await (options.acpProbe ?? unavailableProbe)(instance, signal)
        : undefined;
    if (instance.provider === "claude")
      return normalizeClaude(
        await discoverClaudeModels({
          executable: instance.executable,
          args: instance.args,
          cwd: instance.cwd,
          env: instance.env,
          signal,
          // Only an injected spawn: without one the SDK runs in a helper process, not here.
          ...(options.spawn ? { spawn: options.spawn } : {}),
        }),
        instance,
      );
    if (instance.provider === "pi") {
      const models = await discoverListedModels(instance, signal, spawn, diagnostic);
      const sources = [
        ...new Map(
          models.flatMap((model) =>
            model.source ? [[model.source.id, model.source] as const] : [],
          ),
        ).values(),
      ];
      return discoveredModels(
        models,
        sources.map((source) => ({ source, status: "fresh" })),
      );
    }
    if (instance.provider === "opencode") {
      const report = await discoverOpenCodeCatalog(
        instance,
        signal,
        spawn,
        options.opencode,
        diagnostic,
      );
      return discoveredModels([...report.models], report.sources);
    }
    const args = [...instance.args];
    switch (instance.provider) {
      case "codex":
        args.push("app-server");
        break;
      case "antigravity":
        break;
    }
    const proc = spawn({
      command: acp?.command ?? instance.executable,
      args: acp ? [...acp.args] : args,
      cwd: acp?.cwd ?? instance.cwd,
      env: acp?.env ?? {
        ...instance.env,
        // Unset over the daemon environment the process would otherwise inherit.
        ...Object.fromEntries((instance.unsetEnv ?? []).map((key) => [key, undefined])),
      },
      name: "model-discovery",
      maxOutputBytes: 4 * 1024 * 1024,
    });
    const abort = () => {
      // The stops awaited below report a tree that survives one.
      void proc.stop({ graceMs: 0 }).catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    let rpc: JsonRpcPeer | undefined;
    async function readModels(): Promise<CatalogModel[]> {
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
        // notify() reports a failed send through the peer's onError.
        void rpc.notify("initialized").catch(() => {});
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
      const initialized = InitializeReply.parse(
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
      const peer = rpc;
      const session = await openWithSignIn(
        peer,
        instance.signInMethod,
        () =>
          peer.request(
            "session/new",
            { cwd: acp?.cwd ?? instance.cwd, mcpServers: [] },
            { signal },
          ),
        signal,
      );
      const probed = await withPerModelOptions(session, (method, params) =>
        peer.request(method, params, { signal }),
      );
      const models = normalizeAcp(probed, instance);
      if (acp?.modes === "needs-session") return models;
      return withPermissionModes(
        models,
        acpPermissionModes(session, { provider: instance.provider }),
      );
    }
    try {
      const read = await readModels();
      // An ACP agent may list no models (it runs its own default): a loaded, empty row.
      const rows = acp && !read.length ? discoveredModels(read, []) : read;
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

function unavailableProbe(): Promise<never> {
  return Promise.reject(new Error("ACP model probe unavailable"));
}
