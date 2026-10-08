import { createAcpAdapter, antigravityQuirks } from "@ace/adapter-acp";
import { discoverAntigravity } from "@ace/provider-kit/discovery";
import type { AdapterRegistry } from "../engine/index.ts";
import type { ServiceContext } from "./types.ts";

export async function antigravityDiscovery(context: ServiceContext, signal?: AbortSignal) {
  const command = context.services.providerConfigurations?.for("antigravity").binaryPath;
  const registry = context.services.agentRegistry;
  const installed = registry?.inventory
    .all()
    .findLast(
      (entry) =>
        entry.metadata.acpAgentId === "official:antigravity-acp" && entry.command === command,
    );
  if (registry && installed) {
    const launch = await registry.resolve(
      installed.metadata,
      context.options.providerStatus?.env ?? process.env,
    );
    signal?.throwIfAborted();
    return {
      installed: true,
      installation: installed,
      launch,
      path: launch.command,
      version: launch.version,
      auth: "unknown" as const,
      loginHint: "Sign in to Antigravity",
    };
  }
  const discovery = await discoverAntigravity({
    ...context.options.providerStatus,
    ...(signal ? { signal } : {}),
    ...(command ? { executable: command } : {}),
  });
  if (context.services.antigravityAuth) delete discovery.error;
  return discovery;
}
export async function registerAntigravity(
  context: ServiceContext,
  registry: AdapterRegistry,
): Promise<void> {
  if (context.services.providerConfigurations?.for("antigravity").enabled === false) return;
  const cli = await antigravityDiscovery(context, context.signal);
  if (!cli.installed || !cli.path) return;
  const installation = "installation" in cli ? cli.installation : undefined;
  const agents = context.services.agentRegistry;
  registry.register(
    createAcpAdapter(antigravityQuirks, {
      command: cli.path,
      ...(installation && agents
        ? { resolveLaunch: (session) => agents.resolve(installation.metadata, session.env) }
        : {}),
    }),
    cli,
  );
  context.services.models?.registerInstance({
    id: "antigravity-cli-default",
    provider: "antigravity",
    label: "Antigravity",
    executable: cli.path,
    cwd: context.config.dataDir,
    args: installation?.args ?? [],
    env: installation?.env ?? {},
    loginRevision: installation?.metadata.installationId ?? cli.version ?? "0",
  });
}
