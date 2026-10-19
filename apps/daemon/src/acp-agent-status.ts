import type { AccountRegistry } from "@ace/accounts";
import type { probeOutput } from "@ace/provider-kit/process";
import { acpAgentCli } from "./acp-agent-cli.ts";

/** An installed agent: its registry identity and the command the registry approved. */
export interface InstalledAgent {
  metadata: { acpAgentId: string; instanceId: string };
  command: string;
}

/**
 * Reads the login of every installed ACP agent whose own command reports one (Cursor's
 * `cursor-agent status`), so its account reads signed in or out without a sign-in through ace.
 * Only a change is recorded: each one starts a new login revision.
 */
export async function refreshAcpAgentAuth(options: {
  registry: AccountRegistry;
  installed: readonly InstalledAgent[];
  env: NodeJS.ProcessEnv;
  now(): number;
  probe: typeof probeOutput;
  signal?: AbortSignal;
}): Promise<void> {
  await Promise.all(
    options.registry.list().map(async ({ instance, quota }) => {
      if (instance.provider !== "acp") return;
      const cli = acpAgentCli(instance.acpAgentId);
      const installation = options.installed.findLast(
        (entry) =>
          entry.metadata.instanceId === instance.id &&
          entry.metadata.acpAgentId === instance.acpAgentId,
      );
      if (!cli || !installation) return;
      try {
        const result = await options.probe(installation.command, cli.status, {
          env: options.env,
          timeoutMs: 10_000,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const signedIn = result.code === 0 ? cli.signedIn(result.stdout) : undefined;
        if (signedIn === undefined) return;
        const auth = signedIn ? "logged_in" : "logged_out";
        if (quota.auth !== auth && options.registry.get(instance.id)?.quota.auth !== auth)
          options.registry.recordAcpAuth(instance.id, auth, options.now());
      } catch {
        /* Unknown stays unknown; the next status check asks again. */
      }
    }),
  );
}
