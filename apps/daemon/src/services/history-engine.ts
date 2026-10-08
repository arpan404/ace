import { dirname, resolve, join } from "node:path";
import { z } from "zod";
import { homedir } from "node:os";
import { createInstance, instanceEnv } from "@ace/accounts";
import type { ProviderAdapter, SessionContext } from "@ace/engine-api";
import type { ServiceContext } from "./types.ts";
import type { AdapterRegistry } from "../engine/registry.ts";
import type { Engine } from "../engine/index.ts";
import type { HistoryAdapterPort } from "../history-continuation.ts";

/** History homes are host registration, independent of account scheduling. */
export async function historySessionContext(context: ServiceContext, session: SessionContext) {
  const source = context.options.history?.instances.find((home) => home.id === session.instanceId);
  const imported = context.store.getThread(session.threadId)?.imported;
  if (!source) {
    if (imported && imported.instanceId === session.instanceId)
      throw new Error("History home is no longer registered");
    return undefined;
  }
  if (imported && imported.instanceId === session.instanceId) {
    if (source.provider !== imported.native.provider)
      throw new Error("History provider no longer matches this thread");
    await context.store.writable();
    context.store.atomic((db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS imported_engine_homes (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        home TEXT NOT NULL, instance TEXT NOT NULL, provider TEXT NOT NULL)`);
      const saved = db
        .prepare("SELECT home,instance,provider FROM imported_engine_homes WHERE thread_id=?")
        .get(session.threadId);
      if (saved) {
        const binding = z
          .object({ home: z.string(), instance: z.string(), provider: z.string() })
          .parse(saved);
        if (
          binding.home !== resolve(source.homeDir) ||
          binding.instance !== source.id ||
          binding.provider !== source.provider
        )
          throw new Error("History home no longer matches this thread");
      } else
        db.prepare("INSERT INTO imported_engine_homes VALUES (?,?,?,?)").run(
          session.threadId,
          resolve(source.homeDir),
          source.id,
          source.provider,
        );
    });
  }
  const registered = context.services.accountRegistry?.get(source.id)?.instance;
  if (registered) {
    const dataHome =
      registered.provider === "opencode"
        ? resolve(registered.env.XDG_DATA_HOME ?? "", "opencode")
        : registered.homeDir;
    if (registered.provider !== source.provider || resolve(dataHome) !== resolve(source.homeDir))
      throw new Error("History home no longer matches this account");
    return undefined;
  }
  const instance = createInstance({ ...source, label: source.provider });
  if (source.provider === "opencode")
    instance.env = {
      ...instance.env,
      XDG_DATA_HOME: dirname(source.homeDir),
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    };
  return {
    ...session,
    instanceHomeDir: source.homeDir,
    env: instanceEnv(instance, session.env ?? {}),
  };
}

export function historyEnginePort(
  context: ServiceContext,
  engine: Engine,
  registry: AdapterRegistry,
): HistoryAdapterPort {
  const resolveAdapter = (id: string): ProviderAdapter | undefined => {
    const source = context.options.history?.instances.find((home) => home.id === id);
    if (!source || source.provider === "cursor" || !registry.has(source.provider)) return undefined;
    const entry = registry.get(source.provider);
    if (
      !entry.capabilities.resume ||
      context.services.providerConfigurations?.for(source.provider, id).enabled === false
    )
      return undefined;
    return entry.adapter;
  };
  return {
    resolve: resolveAdapter,
    support: (id) =>
      resolveAdapter(id)
        ? { status: "supported" }
        : {
            status: "unsupported",
            reason:
              "Install and enable a supported version of this provider to continue. You can still import its history.",
          },
    continueOwned: (request, signal) => {
      const thread = context.store.getThread(request.threadId);
      if (!thread?.imported || !resolveAdapter(thread.imported.instanceId))
        return Promise.resolve({
          type: "history.continue",
          status: "unsupported",
          reason: "This provider cannot continue the session. Import it to read the history.",
        });
      return engine.continueImported(request, signal);
    },
    // Sessions owns both callbacks, including bounded ingress while Store publication runs.
    onFrame() {},
    onExit() {},
    pausePersistence: async (signal) => {
      signal.throwIfAborted();
      await engine.flush();
      signal.throwIfAborted();
      return async () => {};
    },
  };
}
