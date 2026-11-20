import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { logFields } from "@ace/diagnostics";
import { measureFolder, mergeArchive, packFiles, packFolder, unpackArchive } from "@ace/files";
import { GitService } from "@ace/git";
import { HostId, WorkspaceId } from "@ace/protocol";
import { Profiles } from "../cli/profiles.ts";
import { computerName } from "../computer-name.ts";
import { loadHostId } from "../local-files.ts";
import type { ServiceContext } from "../services/types.ts";
import { AgentTransfers } from "./agent.ts";
import { transferTransport, type TransferTransport } from "./client.ts";
import { routedTransfers } from "./routes.ts";
import { MachineConnections } from "../machines/connections.ts";
import { SavedPairings } from "../machines/saved-pairings.ts";
import { TransferCommands } from "./commands.ts";
import { IncomingTransfers } from "./incoming.ts";
import { transferIdentities } from "./identity.ts";
import { OutgoingTransfers } from "./outgoing.ts";
import { TransferError } from "./ports.ts";
import { threadGone } from "../thread-gone.ts";
import { sourceThreads, targetProjects, targetThreads } from "./service-adapters.ts";
import { liveResumePorts, liveSourcePorts, liveTargetPorts } from "./live/adapters.ts";
import { LiveResumes } from "./live/resumes.ts";
import { ThreadOwnership } from "./live/ownership.ts";
import { LiveSource } from "./live/source.ts";
import { LiveTarget } from "./live/target.ts";

export interface DaemonTransfers {
  outgoing: OutgoingTransfers;
  incoming: IncomingTransfers;
  commands: TransferCommands;
  agents: AgentTransfers;
}

/** The shell's timer for closing idle connections; nothing waits on it at exit. */
function schedule(ms: number, run: () => void) {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
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
 * Work on another machine (ADR 0101): this machine sending projects and threads to the person's
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
  const archive = { measureFolder, packFolder, packFiles, unpackArchive, mergeArchive };
  const directory = join(config.dataDir, "transfers");
  const profiles = () => {
    const table = new Profiles(config.dataDir);
    try {
      return table.list();
    } finally {
      table.close();
    }
  };

  // Probes, calls and chunks to one machine share one kept-open, pinned connection.
  // The pairings saved now, through one kept-open reader that re-reads only when they change:
  // a transfer holding one removed since, here or by `ace remote remove`, is refused.
  const saved = new SavedPairings(config.dataDir, record("warn"));
  resources.own(() => saved.close());
  const connections = new MachineConnections({ schedule, saved });
  resources.own(() => connections.close());
  // Unlinking from Settings ends the machine's transfer connections before it reports done.
  const unfollow = services.fleet?.onChange((listed) => connections.retain(listed));
  if (unfollow) resources.own(unfollow);
  // Every route parcels use reaches the machine for transfers too (ADR 0192).
  const transport: TransferTransport = routedTransfers({
    direct: options.transfers?.transport ?? transferTransport,
    connections,
    links: () => services.parcels?.links,
    current: (profile) => saved.holds(profile),
    now,
  });

  // Which machine owns each thread (ADR 0191); the engine's fence reads the same record.
  const ownership = new ThreadOwnership(store);
  // What a failed move owes the agent, sent until it goes, across restarts.
  const resumes = new LiveResumes(
    liveResumePorts(context, { sleep: options.transfers?.sleep ?? sleep, log: record("warn") }),
  );
  resources.own(() => resumes.close());
  const identities = transferIdentities(store, () => services.projects?.catalog, randomUUID, now);
  const incoming = new IncomingTransfers({
    store,
    directory: join(directory, "incoming"),
    git,
    gitPolicy: options.projects?.gitPolicy,
    archive,
    projects: targetProjects(context),
    threads: targetThreads(context),
    identities,
    live: new LiveTarget(
      liveTargetPorts(context, {
        ownership,
        git,
        archive,
        newSessionId: randomUUID,
        log: record("warn"),
      }),
    ),
    now,
    log: record("info"),
  });
  resources.own(() => incoming.close());
  services.transferTarget = { incoming, hostId, hostName, log: record("warn") };

  const outgoing = new OutgoingTransfers({
    store,
    directory: join(directory, "outgoing"),
    git,
    gitPolicy: options.projects?.gitPolicy,
    archive,
    transport,
    profiles: () => {
      const listed = profiles();
      connections.retain(listed);
      return listed;
    },
    origin: async () => ({
      hostId: HostId.parse(hostId),
      hostName: ((await hostName()) || "ace").slice(0, 256),
    }),
    threads: sourceThreads(context),
    now,
    sleep: options.transfers?.sleep ?? sleep,
    nextId: randomUUID,
    identities,
    live: new LiveSource(
      liveSourcePorts(context, {
        ownership,
        git,
        archive,
        resumes,
        sleep: options.transfers?.sleep ?? sleep,
      }),
    ),
    log: record("info"),
    ...(options.transfers?.offlineMs ? { offlineMs: options.transfers.offlineMs } : {}),
  });
  resources.own(() => outgoing.close());
  const commands = new TransferCommands({
    store,
    outgoing,
    ignoredByDefault: async () =>
      (await services.settings?.get("remote.transferIgnoredFiles"))?.value ?? true,
    continueRefusal: async (id) => {
      const runtime = services.workspaceActions;
      if (!runtime) return "workspace_unavailable";
      return runtime.continueRefusal(id);
    },
    // A delegated child moves with its parent; a thread already moving can't move again.
    liveRefusal: (id) =>
      services.agentControl?.delegations.journal.get(id)
        ? "thread_is_child"
        : ownership.refusal(id)?.code,
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
    // A thread that is gone holds nothing: its transfer's hold went with it.
    hold: (threadId, agentId, transferId, change) => {
      if (threadGone((id) => store.getThread(id), services.engine, threadId)) return;
      services.engine?.transferHold(threadId, agentId, transferId, change);
    },
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
  // Each side recovers on its own: a home indexing its incoming history doesn't hold up the
  // transfers it is sending (ADR 0170).
  const recovering = (side: string, run: () => Promise<void>) =>
    run().catch((error: unknown) =>
      record("warn")("Transfers could not recover", { side, error: String(error) }),
    );
  void recovering("incoming", () => incoming.recover());
  void recovering("outgoing", async () => {
    await outgoing.recover();
    for (const pending of outgoing.undelivered()) agents.settled(pending);
  });
  resumes.start();
}
