import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { logFields } from "@ace/diagnostics";
import { measureFolder, packFolder, unpackArchive } from "@ace/files";
import { GitService } from "@ace/git";
import { HostId, WorkspaceId } from "@ace/protocol";
import { Profiles } from "../cli/profiles.ts";
import { computerName } from "../computer-name.ts";
import { loadHostId } from "../local-files.ts";
import type { ServiceContext } from "../services/types.ts";
import { AgentTransfers } from "./agent.ts";
import { transferTransport } from "./client.ts";
import { TransferCommands } from "./commands.ts";
import { IncomingTransfers } from "./incoming.ts";
import { OutgoingTransfers } from "./outgoing.ts";
import { TransferError } from "./ports.ts";
import { sourceThreads, targetProjects, targetThreads } from "./service-adapters.ts";

export interface DaemonTransfers {
  outgoing: OutgoingTransfers;
  incoming: IncomingTransfers;
  commands: TransferCommands;
  agents: AgentTransfers;
}

/** Waits `ms`, or less when the transfer is cancelled. The shell's only timer. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Work on another machine (ADR 0099): this machine sending projects and threads to the person's
 * other machines over their fleet links, and receiving them from those machines.
 */
export function startTransfers(context: ServiceContext): void {
  const { services, store, config, options, log, resources, now } = context;
  const hostId = loadHostId(config.dataDir);
  const fallbackName = computerName();
  const hostName = async () =>
    (await services.settings?.get("host.displayName"))?.value || (await fallbackName);
  const record = (level: "info" | "warn") => (message: string, fields: Record<string, unknown>) =>
    log.log(level, message, logFields(Object.entries(fields)));
  const git = new GitService({ timeoutMs: 600_000, ...options.projects?.git }).transfer;
  const archive = { measureFolder, packFolder, unpackArchive };
  const directory = join(config.dataDir, "transfers");
  const profiles = () => {
    const table = new Profiles(config.dataDir);
    try {
      return table.list();
    } finally {
      table.close();
    }
  };

  const incoming = new IncomingTransfers({
    store,
    directory: join(directory, "incoming"),
    git,
    archive,
    projects: targetProjects(context),
    threads: targetThreads(context),
    now,
    log: record("info"),
  });
  resources.own(() => incoming.close());
  services.transferTarget = { incoming, hostId, hostName, log: record("warn") };

  const outgoing = new OutgoingTransfers({
    store,
    directory: join(directory, "outgoing"),
    git,
    archive,
    transport: options.transfers?.transport ?? transferTransport,
    profiles,
    origin: async () => ({
      hostId: HostId.parse(hostId),
      hostName: ((await hostName()) || "ace").slice(0, 256),
    }),
    threads: sourceThreads(context),
    now,
    sleep: options.transfers?.sleep ?? sleep,
    nextId: randomUUID,
    log: record("info"),
    ...(options.transfers?.offlineMs ? { offlineMs: options.transfers.offlineMs } : {}),
  });
  resources.own(() => outgoing.close());
  const commands = new TransferCommands({
    store,
    outgoing,
    continueRefusal: async (id) => {
      const runtime = services.workspaceActions;
      if (!runtime) return "workspace_unavailable";
      return runtime.continueRefusal(id);
    },
  });
  const agents = new AgentTransfers({
    store,
    commands,
    outgoing,
    enabled: async () => (await services.settings?.get("remote.agentTransfers"))?.value ?? true,
    project: (name) => {
      const rows = store
        .statement(
          "SELECT id,name FROM workspaces WHERE NOT EXISTS(SELECT 1 FROM workspace_unregistered WHERE workspace_id=workspaces.id) ORDER BY rowid DESC LIMIT 64",
        )
        .all();
      const found =
        rows.find((row) => row["id"] === name) ??
        rows.find((row) => String(row["name"]).toLowerCase() === name.toLowerCase());
      return found ? WorkspaceId.parse(found["id"]) : undefined;
    },
    hold: (threadId, agentId, transferId, change) =>
      services.engine?.transferHold(threadId, agentId, transferId, change),
    deliver: (threadId, key, text) => {
      const parent = store.getThread(threadId);
      if (!parent || parent.deletedAt !== undefined) return;
      const delegations = services.agentControl?.delegations;
      if (!delegations) throw new TransferError("not_ready", "Agent control is not ready");
      const result = delegations.command(key, {
        type: "thread.send",
        threadId,
        input: [{ type: "text", text }],
        delivery: "queue",
        trigger: "subagent_result",
        origin: { kind: "subagent_result" },
      });
      if (!result.ok) throw new TransferError("not_delivered", result.error ?? "refused");
    },
    now,
  });
  resources.own(outgoing.onSettled((settled) => agents.settled(settled)));
  // Stopping the transfer's background row in the thread cancels the transfer.
  services.engine?.bindExternalTaskStop("ace-transfer:", (id) => {
    void outgoing
      .cancel(id)
      .catch((error: unknown) =>
        record("warn")("Transfer not cancelled", { error: String(error) }),
      );
  });
  services.transfers = { outgoing, incoming, commands, agents };
  void (async () => {
    await incoming.recover();
    await outgoing.recover();
    for (const pending of outgoing.undelivered()) agents.settled(pending);
  })().catch((error: unknown) =>
    record("warn")("Transfers could not recover", { error: String(error) }),
  );
}
