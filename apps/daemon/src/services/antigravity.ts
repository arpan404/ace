import { homedir } from "node:os";
import { createAcpAdapter, antigravityQuirks } from "@ace/adapter-acp";
import { antigravityIdentity, createAntigravityInstance } from "@ace/accounts";
import { discoverAntigravity } from "@ace/provider-kit/discovery";
import { checkCli } from "@ace/provider-kit/cli-requirements";
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
    const versionCheck = checkCli("antigravity", installed.metadata.version);
    // Too old to launch: report it (sessions are refused at launch) instead of failing discovery.
    if (versionCheck.status === "too_old")
      return {
        installed: true,
        installation: installed,
        path: installed.command,
        version: installed.metadata.version,
        versionCheck,
        auth: "unknown" as const,
        loginHint: "Sign in to Antigravity",
      };
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
      versionCheck,
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
  await registerAntigravityAccount(context);
}

/** The CLI login's account row, where `agy /usage` puts its limits. Never blocks the provider. */
async function registerAntigravityAccount(context: ServiceContext): Promise<void> {
  const accounts = context.services.accountRegistry;
  if (!accounts) return;
  try {
    if (accounts.get(antigravityIdentity.instanceId)) return;
    await accounts.register(
      createAntigravityInstance(
        context.options.providerStatus?.env?.HOME ?? process.env.HOME ?? homedir(),
      ),
    );
  } catch {
    /* No row this time (homes still being validated): the next discovery adds it. */
  }
}
