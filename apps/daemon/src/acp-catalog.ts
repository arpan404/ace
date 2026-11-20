import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  acpAgentCli,
  geminiWorkspaceTrust,
  matchProfile,
  readGeminiTrustFacts,
  type AgentRegistry,
} from "@ace/agent-registry";
import { createAcpInstance } from "@ace/accounts";
import type { AcpProbeLaunch, InstanceInput, ModelCatalog, ModelInstance } from "@ace/models";
import { AcpIdentity } from "@ace/protocol";
import { acpModelInstanceId } from "./acp-model-instance.ts";
import type { DaemonOptions } from "./services/options.ts";
import type { Services } from "./services/types.ts";

/**
 * A generic ACP agent's model catalog row: registered for each approved agent at daemon start,
 * kept current by its sessions, and loaded before its first thread by a metadata-only probe in
 * ace's own folder (ADR 0044, amendment "models before the first thread").
 */
export type AcpCatalogContext = {
  agents: AgentRegistry;
  models: ModelCatalog;
  options: Pick<DaemonOptions, "acpEnvironment">;
  accounts?: Services["accounts"];
  accountRegistry?: Services["accountRegistry"];
  /** ace's data folder; the probe's neutral folder is made inside it when a probe starts. */
  dataDir: string;
  userHome?: string;
  platform?: string;
};

/** Antigravity runs as its own provider, with its own catalog rows (`services/antigravity.ts`). */
const ownProvider = "official:antigravity-acp";

/** Where probe sessions open: ace's own, never a project, so no project's files or trust apply. */
export function acpProbeFolder(dataDir: string): string {
  return join(dataDir, "acp-model-probe");
}

/** The account environment and login generation an agent's sessions and probes run with. */
export function acpAccount(
  context: Pick<AcpCatalogContext, "options" | "accounts">,
  identity: AcpIdentity,
): { env: NodeJS.ProcessEnv; loginRevision: string } {
  return (
    context.options.acpEnvironment?.(identity) ??
    context.accounts?.acpEnvironment(identity) ?? {
      env: process.env,
      loginRevision: "default-local",
    }
  );
}

/** The agent's default account (its CLI login), registered the first time ace needs it. */
export async function ensureAcpAccount(
  context: Pick<AcpCatalogContext, "agents" | "accounts" | "accountRegistry" | "userHome">,
  identity: AcpIdentity,
): Promise<void> {
  if (!context.accounts || !context.accountRegistry) return;
  if (context.accountRegistry.get(identity.instanceId)) return;
  const installation = context.agents.inventory
    .list()
    .find(
      (entry) =>
        entry.installationId === identity.installationId &&
        entry.acpAgentId === identity.acpAgentId &&
        entry.instanceId === identity.instanceId,
    );
  if (!installation) throw new Error("Approved ACP installation unavailable");
  await context.accountRegistry.register(
    createAcpInstance({
      identity,
      label: identity.acpAgentId.slice(0, 128),
      userHome: context.userHome ?? homedir(),
      installation,
    }),
  );
}

/**
 * The row for one agent and account. Its folder is ace's probe folder, whichever project a
 * thread runs in, and it is no part of the row's identity: one row serves every project.
 */
export function acpCatalogInstance(
  identity: AcpIdentity,
  loginRevision: string,
  launch: { command: string; args: readonly string[]; version: string; profileRevision?: string },
  dataDir: string,
): InstanceInput {
  return {
    id: acpModelInstanceId(identity),
    provider: "acp",
    ...identity,
    loginRevision,
    executable: launch.command,
    cwd: acpProbeFolder(dataDir),
    args: [...launch.args],
    // The launch environment stays on the daemon-local plan, outside model metadata.
    env: {},
    profileRevision: launch.profileRevision ?? "generic-v1",
    installationVersion: launch.version,
    // ADR 0044: only a reviewed profile may open an empty session unasked.
    modelProbe: launch.profileRevision ? "automatic" : "on-request",
  };
}

/** The profile ace reviewed for this agent and version, as `AgentRegistry.resolve` matches it. */
function profileRevision(acpAgentId: string, version: string): string | undefined {
  return acpAgentId.startsWith("official:")
    ? matchProfile(acpAgentId.slice(9), version)?.revision
    : undefined;
}

/**
 * Registers a row for each approved agent from its stored installation alone: no launch, no
 * digest, no probe. Bounded by the installation inventory, never by stored threads.
 */
export async function registerApprovedAcpAgents(
  context: AcpCatalogContext,
  report: (error: unknown) => void,
): Promise<void> {
  for (const installation of context.agents.inventory.all()) {
    const { metadata } = installation;
    if (metadata.acpAgentId === ownProvider) continue;
    try {
      await registerAcpAgent(context, metadata, {
        command: installation.command,
        args: installation.args,
        version: metadata.version,
      });
    } catch (error) {
      report(error);
    }
  }
}

/** One agent's row, unless one is already registered (a session may have registered it). */
export async function registerAcpAgent(
  context: AcpCatalogContext,
  agent: AcpIdentity,
  launch: { command: string; args: readonly string[]; version: string },
): Promise<void> {
  // Only the identity's own fields: the row's id is a digest of them.
  const identity = AcpIdentity.parse(agent);
  const id = acpModelInstanceId(identity);
  if (context.models.hasInstance(id)) return;
  await ensureAcpAccount(context, identity);
  const { loginRevision } = acpAccount(context, identity);
  if (context.models.hasInstance(id)) return;
  const revision = profileRevision(identity.acpAgentId, launch.version);
  context.models.registerInstance(
    acpCatalogInstance(
      identity,
      loginRevision,
      { ...launch, ...(revision ? { profileRevision: revision } : {}) },
      context.dataDir,
    ),
  );
}

/**
 * How the catalog's probe of an agent runs: the approved launch with the account's environment,
 * in ace's probe folder, made on demand. ace grants that folder no trust: Gemini, which hides
 * its privileged modes in a folder it does not trust, reports modes there that are not the
 * agent's, so they are left for a session to report.
 */
export function acpProbeLauncher(
  context: AcpCatalogContext,
): (instance: ModelInstance, signal: AbortSignal) => Promise<AcpProbeLaunch> {
  return async (instance, signal) => {
    const identity = AcpIdentity.parse(instance);
    const account = acpAccount(context, identity);
    if (account.loginRevision !== instance.loginRevision)
      throw new Error("ACP account changed since its catalog row registered");
    const plan = await context.agents.resolve(identity, account.env);
    signal.throwIfAborted();
    const cwd = acpProbeFolder(context.dataDir);
    await mkdir(cwd, { recursive: true });
    const trusted =
      acpAgentCli(identity.acpAgentId) !== "gemini" ||
      geminiWorkspaceTrust(
        await readGeminiTrustFacts({
          env: plan.env,
          userHome: context.userHome ?? homedir(),
          platform: context.platform ?? process.platform,
          cwd,
        }),
      ).state === "trusted";
    return {
      command: plan.command,
      args: plan.args,
      env: plan.env,
      cwd,
      modes: trusted ? "reported" : "needs-session",
    };
  };
}
