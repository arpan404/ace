import { logFields } from "@ace/diagnostics";
import {
  AgentId,
  HostId,
  ThreadId,
  type AgentControlOperation,
  type AgentControlResult,
  type MachineDescription,
  type McpAttribution,
} from "@ace/protocol";
import { connectClientViaRelay } from "@ace/relay";
import { AgentControlError } from "../agent-control/failure.ts";
import { Profiles, type RemoteProfile } from "../cli/profiles.ts";
import { computerName } from "../computer-name.ts";
import { loadHostId } from "../local-files.ts";
import { pinnedRequest } from "../machines/transport.ts";
import type { ServiceContext } from "../services/types.ts";
import { ParcelFileError, ParcelFiles } from "./files.ts";
import { isHostedRelay } from "../relay-account.ts";
import { pairingKey, recordDescription } from "./descriptions.ts";
import { ParcelLink, samePairing } from "./link.ts";
import { arrivalText, receivedView, sentView } from "./messages.ts";
import { ParcelPuller } from "./puller.ts";
import { RelayLink } from "../machines/relay-link.ts";
import { PARCEL_DEADLINE_MS, projectRelative } from "./rules.ts";
import { ParcelSender, type SenderThread } from "./sender.ts";
import { ParcelRows, type InRow } from "./store.ts";
import { parcelTarget, type ParcelTarget } from "./target.ts";

type ParcelOperation = Extract<AgentControlOperation, { op: "data.send" | "data.receive" }>;

export interface DaemonParcels {
  target: ParcelTarget;
  /** Machine calls through a relay, for any op whose direct attempt never reached the machine. */
  relayCalls: import("../machines/relay-fallback.ts").RelayCalls;
  /** The routes and relay streams to each machine, which transfers use too (ADR 0192). */
  links: import("../transfers/routes.ts").MachineLinks;
  /** The agents' `data_send` and `data_receive`. */
  agent(caller: McpAttribution, operation: ParcelOperation): Promise<AgentControlResult>;
  /** A linked machine described itself: its paths are kept for when its address fails. */
  described(profile: RemoteProfile, description: MachineDescription): void;
}

/** Parcels held here at most, staged and received together. */
const QUOTA_BYTES = 8 * 1024 * 1024 * 1024;
/** Received parcels are kept this long after they arrive. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_MS = 10 * 60 * 1000;

function schedule(ms: number, run: () => void) {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

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
 * Data between agents (ADR 0182): the agents' tools, this machine's end of parcels pushed to
 * and pulled from other machines, the routes to them and the background work that resumes,
 * delivers and expires parcels. Started after machines, so machine calls dispatch here.
 */
export function startParcels(context: ServiceContext): void {
  const { services, store, config, options, log, resources, now } = context;
  const hostId = loadHostId(config.dataDir);
  const fallbackName = computerName();
  const hostName = async () =>
    (await services.settings?.get("host.displayName"))?.value || (await fallbackName);
  const record = (level: "info" | "warn") => (message: string, fields: Record<string, unknown>) =>
    log.log(level, message, logFields(Object.entries(fields)));
  const rows = new ParcelRows(store);
  const files = new ParcelFiles(config.dataDir);
  const profiles = () => {
    const table = new Profiles(config.dataDir);
    try {
      return table.list();
    } finally {
      table.close();
    }
  };
  const relay = new RelayLink({
    connect: options.parcels?.connectRelay ?? connectClientViaRelay,
    aceClient: config.aceClient,
    // ace's relay admits only devices on the machine's own account (ADR 0111).
    // Only ace's own relay ever gets an account grant: a relay a paired machine names is not
    // trusted with one (it could replay it), and is reached without a grant.
    deviceGrant: async (deviceId, url, signal) =>
      services.relayDeviceGrant?.(deviceId, url, signal).catch(() => undefined),
    schedule,
    // The same pairing still saved: its device and token there.
    current: (target) =>
      profiles().some(
        (profile) => profile.deviceId === target.deviceId && profile.token === target.token,
      ),
  });
  resources.own(() => relay.close());
  // Linking again or unlinking ends the relay streams of the old pairings before it reports done.
  const unfollowLinks = services.fleet?.onChange(() => void relay.close());
  if (unfollowLinks) resources.own(unfollowLinks);
  const link = new ParcelLink({
    pinned: options.parcels?.pinned ?? pinnedRequest,
    // Polling every linked machine must not open a TLS connection per call: parcels share the
    // machine's kept-open connections, which also refuse a pairing no longer saved.
    ...(services.pairedMachines ? { connections: services.pairedMachines.connections } : {}),
    current: (profile) => {
      try {
        const saved = services.pairedMachines ? services.pairedMachines.saved() : profiles();
        return saved?.some((entry) => samePairing(entry, profile)) ?? false;
      } catch {
        // Pairings that can't be read hold nothing: nothing is sent.
        return false;
      }
    },
    relay,
    paths: (profile) => rows.paths(profile.id)?.paths ?? [],
    hosted: (url) => isHostedRelay(url, config.hostedRelayUrl),
    pins: (profile) => rows.pins(profile.id, pairingKey(profile)),
    now,
  });
  const room = () => Math.max(0, QUOTA_BYTES - rows.heldBytes());
  const pollMs = options.parcels?.pollMs ?? options.machines?.pollMs ?? 2000;
  const statement = (sql: string) => store.statement(sql);
  const thread = (id: string): SenderThread | undefined => {
    const parsed = ThreadId.safeParse(id);
    if (!parsed.success) return undefined;
    const found = store.getThread(parsed.data);
    if (!found) return undefined;
    const folder = statement("SELECT cwd FROM engine_sessions WHERE thread_id=?").get(id)?.["cwd"];
    return {
      id,
      title: found.title ?? "",
      delegatedBy: found.delegatedBy,
      deleted: found.deletedAt !== undefined,
      readOnly: found.permission?.effective === "read-only",
      folder: typeof folder === "string" ? folder : undefined,
    };
  };
  const remoteChild = (id: string) => {
    const row = statement("SELECT parent_thread,machine FROM machine_children WHERE id=?").get(id);
    return row
      ? { parentThread: String(row["parent_thread"]), machine: String(row["machine"]) }
      : undefined;
  };
  const deliver = (threadId: string, key: string, text: string) => {
    const target = store.getThread(ThreadId.parse(threadId));
    if (!target || target.deletedAt !== undefined) return;
    const delegations = services.agentControl?.delegations;
    if (!delegations) throw new Error("Agent control is not ready");
    const result = delegations.command(key, {
      type: "thread.send",
      threadId: ThreadId.parse(threadId),
      input: [{ type: "text", text }],
      delivery: "queue",
      trigger: "background_completion",
      origin: { kind: "background_completion" },
    });
    if (!result.ok) throw new Error(result.error ?? "refused");
  };
  /** A verified parcel: its thread is told once, now or on a later sweep. */
  const arrived = (row: InRow) => {
    try {
      deliver(
        row.toThread,
        `parcel-arrival:${row.parcelId}`,
        arrivalText(row, files.placed(row.parcelId, row.facts.name)),
      );
      rows.updateIn(row.parcelId, { notified: true }, now());
    } catch {
      // Told on the next sweep or start.
    }
  };
  const origin = async (threadId: string, agentId?: string) => {
    const caller = thread(threadId);
    return {
      hostId: HostId.parse(hostId),
      hostName: ((await hostName()) || "ace").slice(0, 256),
      threadId: ThreadId.parse(threadId),
      threadTitle: (caller?.title ?? "").slice(0, 256),
      ...(agentId ? { agentId: AgentId.parse(agentId) } : {}),
      ceiling: caller?.readOnly ? ("read" as const) : ("operate" as const),
    };
  };
  const sender = new ParcelSender({
    rows,
    files,
    link,
    profiles,
    thread,
    remoteChild,
    remoteParent: (id) => {
      const row = statement(
        `SELECT m.device_id, m.origin_host, m.origin_thread, d.name FROM machine_threads m
         LEFT JOIN devices d ON d.id = m.device_id WHERE m.thread_id=? AND m.kind='delegate'`,
      ).get(id);
      return row
        ? {
            deviceId: String(row["device_id"]),
            originHost: String(row["origin_host"]),
            originThread: String(row["origin_thread"]),
            machine: typeof row["name"] === "string" ? row["name"] : "the other machine",
          }
        : undefined;
    },
    origin,
    hold: (threadId, agentId, key, change) =>
      services.engine?.externalHold(ThreadId.parse(threadId), AgentId.parse(agentId), key, change),
    deliver,
    arrived,
    room,
    holdGone: (threadId, agentId, error) => {
      const parsed = ThreadId.safeParse(threadId);
      const found = parsed.success ? store.getThread(parsed.data) : undefined;
      if (!found || found.deletedAt !== undefined) return true;
      // The engine names an agent it no longer knows this way (`externalHold`).
      return error instanceof Error && error.message === "Unknown background owner" && !!agentId;
    },
    reopenChild: (id) => {
      const parsed = ThreadId.safeParse(id);
      if (parsed.success) services.machines?.children.reopen(parsed.data);
    },
    now,
    schedule,
    log: record("info"),
  });
  resources.own(() => sender.close());
  const puller = new ParcelPuller({
    rows,
    files,
    link,
    profiles,
    machinesWithChildren: () => {
      const found = new Map<string, string>();
      // A child settled lately may be working again (a parcel or message reopened it), so its
      // machine is asked too; the parent's view of it may lag.
      for (const row of statement(
        "SELECT machine, MIN(parent_thread) AS parent FROM machine_children WHERE settled=0 OR settled_at > ? GROUP BY machine LIMIT 64",
      ).all(now() - PARCEL_DEADLINE_MS))
        found.set(String(row["machine"]), String(row["parent"]));
      return found;
    },
    remoteChild,
    live: (id) => {
      const found = thread(id);
      return found !== undefined && !found.deleted;
    },
    origin: (threadId) => origin(threadId),
    arrived,
    room,
    now,
    pollMs,
    log: record("warn"),
  });
  const target = parcelTarget({
    rows,
    files,
    owns: (device, threadId) => services.machineThreads?.owns(device, threadId) ?? false,
    guest: (threadId) =>
      statement("SELECT 1 FROM machine_threads WHERE thread_id=? AND kind='guest'").get(
        threadId,
      ) !== undefined,
    room,
    arrived,
    acknowledged: (parcelId, outcome, reason) =>
      sender.settle(
        parcelId,
        outcome === "delivered" ? "delivered" : "failed",
        outcome === "refused" ? (reason ?? "Its parent refused it.") : undefined,
      ),
    now,
  });
  services.engine?.bindExternalTaskStop("ace-parcel:", (id) => {
    void sender
      .cancel(id.replace(/^ace-parcel:/, ""))
      .catch((error: unknown) => record("warn")("Parcel not cancelled", { error: String(error) }));
  });

  /** Expiry, late notices and results that couldn't be handed over before. */
  const sweep = async () => {
    const at = now();
    for (const row of rows.staleOutbox(at - PARCEL_DEADLINE_MS))
      sender.settle(row.parcelId, "failed", "Its parent didn't collect it within a day.");
    // Arrivals their sender abandoned free their space after a day; delivered ones after a week.
    for (const row of [
      ...rows.staleReceiving(at - PARCEL_DEADLINE_MS),
      ...rows.expiredIn(at - KEEP_MS),
    ]) {
      await files.removeIn(row.parcelId);
      rows.updateIn(row.parcelId, { state: "cancelled", held: 0 }, at);
    }
    for (const row of rows.undeliveredOut()) sender.report(row.parcelId);
    for (const row of rows.unnotifiedIn()) arrived(row);
    sender.kick();
  };
  const stopping = new AbortController();
  resources.own(() => stopping.abort());
  // Collecting and sweeping run on their own: a long pull never holds up expiry or retries.
  const every = (ms: number, work: () => Promise<void>, failed: string) => {
    void (async () => {
      while (!stopping.signal.aborted) {
        await sleep(ms, stopping.signal);
        if (stopping.signal.aborted) return;
        await work().catch((error: unknown) => record("warn")(failed, { error: String(error) }));
      }
    })();
  };
  void services.engine
    ?.ready()
    .then(() => {
      // The loops start at once; copies a restart cut off are redone beside them.
      every(pollMs, () => puller.round(stopping.signal), "Parcels not collected");
      every(Math.min(SWEEP_MS, pollMs * 30), sweep, "Parcel sweep failed");
      void sweep().catch((error: unknown) =>
        record("warn")("Parcel sweep failed", { error: String(error) }),
      );
      return sender.recoverLocal();
    })
    .catch((error: unknown) => record("warn")("Parcels not recovered", { error: String(error) }));

  const described = (profile: RemoteProfile, description: MachineDescription) =>
    recordDescription(rows, profiles(), profile, description, now());

  async function receive(
    caller: McpAttribution,
    operation: Extract<ParcelOperation, { op: "data.receive" }>,
  ): Promise<AgentControlResult> {
    if (!operation.parcelId) {
      const { sent, received } = rows.forThread(caller.threadId);
      return {
        ok: true,
        data: {
          received: received.map((row) =>
            receivedView(
              row,
              row.state === "delivered" ? files.placed(row.parcelId, row.facts.name) : undefined,
            ),
          ),
          sent: sent.map(sentView),
        },
      };
    }
    const row = rows.in(operation.parcelId);
    if (!row || row.toThread !== caller.threadId) {
      const mine = rows.out(operation.parcelId);
      if (mine && mine.fromThread === caller.threadId) return { ok: true, data: sentView(mine) };
      throw new AgentControlError(
        "not_found",
        "parcel_not_found",
        undefined,
        "No such parcel for this thread.",
      );
    }
    const path = row.state === "delivered" ? files.placed(row.parcelId, row.facts.name) : undefined;
    if (!operation.saveAs) return { ok: true, data: receivedView(row, path) };
    const self = thread(caller.threadId);
    if (!self || self.readOnly || !self.folder)
      throw new AgentControlError(
        "machine_forbidden",
        "read_only_caller",
        undefined,
        "This thread can't write to its project; read the parcel at its path instead.",
      );
    if (row.state !== "delivered")
      throw new AgentControlError(
        "not_found",
        "parcel_not_arrived",
        undefined,
        "That parcel hasn't arrived.",
      );
    const relative = projectRelative(operation.saveAs);
    if (!relative)
      throw new AgentControlError(
        "invalid_arguments",
        "save_outside",
        undefined,
        "saveAs must be a new path inside your project, not in .git.",
      );
    try {
      const saved = await files.saveAs(row.parcelId, row.facts.name, self.folder, relative);
      return { ok: true, data: { ...receivedView(row, path), savedAt: saved } };
    } catch (error) {
      if (error instanceof ParcelFileError)
        throw new AgentControlError("invalid_arguments", error.code, undefined, error.message);
      throw error;
    }
  }

  services.parcels = {
    target,
    relayCalls: {
      call: (profile, body, callOptions) =>
        link.relays(profile, body, {
          timeoutMs: callOptions.timeoutMs,
          ...(callOptions.signal ? { signal: callOptions.signal } : {}),
        }),
      prefers: (profile) => link.prefersRelay(profile),
    },
    links: { machines: link.machines, relay },
    described,
    async agent(caller, operation) {
      if (operation.op === "data.receive") return receive(caller, operation);
      const result = await sender.send(caller, operation);
      return { ok: true, data: result };
    },
  };
}
