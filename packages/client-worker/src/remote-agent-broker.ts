import { returnRemoteArtifacts } from "./remote-artifact-return.ts";
import { transferRemoteContext } from "./remote-context-transfer.ts";
import { ClientError, type ClientApi, type Scheduler } from "@ace/client";
import { HostId, RemoteAgentHost, type RemoteTask, type RemoteTaskReport } from "@ace/protocol";
import type { MachinePool } from "./machines.ts";

type RemoteClient = Pick<ClientApi, "request"> & {
  projects: Pick<ClientApi["projects"], "recentFolders">;
};
export interface RemoteBrokerPool {
  readonly ids: readonly string[];
  machine(host: string): ReturnType<MachinePool["machine"]>;
  client(host: string): RemoteClient;
  contextRelay?: MachinePool["contextRelay"];
}
/** Paired host routing only. The originating daemon owns task identity, leases and recovery. */
export class RemoteAgentBroker {
  private primary: Pick<ClientApi, "state" | "request">;
  private pool: RemoteBrokerPool;
  private scheduler: Scheduler;
  private closed = false;
  private timer: (() => void) | undefined;
  private running: Promise<void> | undefined;
  private cache = new Map<string, { client: RemoteClient; at: number; host: RemoteAgentHost }>();
  private now: () => number;
  private refreshes = new Map<string, Promise<void>>();
  private importFailures = new Map<string, number>();
  private cursor: string | undefined;
  private jobs = new Map<string, { host: string; work: Promise<void> }>();
  constructor(options: {
    primary: Pick<ClientApi, "state" | "request">;
    pool: RemoteBrokerPool;
    scheduler: Scheduler;
    now: () => number;
  }) {
    this.primary = options.primary;
    this.pool = options.pool;
    this.scheduler = options.scheduler;
    this.now = options.now;
  }
  start() {
    this.closed = false;
    this.tick();
  }
  close() {
    this.closed = true;
    this.timer?.();
    this.cache.clear();
    this.importFailures.clear();
  }
  private tick() {
    if (this.closed) return;
    void this.cycle()
      .catch(() => {})
      .finally(() => {
        if (!this.closed) this.timer = this.scheduler.set(1000, () => this.tick());
      });
  }
  cycle(): Promise<void> {
    return (this.running ??= this.work().finally(() => {
      this.running = undefined;
    }));
  }
  private hosts(): RemoteAgentHost[] {
    const found: RemoteAgentHost[] = [];
    for (const id of this.pool.ids.slice(0, 32)) {
      const state = this.pool.machine(id);
      if (state?.status !== "online") continue;
      const client = this.pool.client(id);
      const cached = this.cache.get(id);
      if (cached?.client === client) found.push(cached.host);
      if (
        (!cached || cached.client !== client || this.now() - cached.at >= 60000) &&
        !this.refreshes.has(id)
      ) {
        const work = this.refreshHost(id, client)
          .catch(() => {
            this.cache.delete(id);
          })
          .finally(() => {
            this.refreshes.delete(id);
          });
        this.refreshes.set(id, work);
      }
    }
    return found;
  }
  private async refreshHost(id: string, client: RemoteClient) {
    const transport = await client.request({ type: "delegation.remote.transport" });
    if (!transport.ok || !transport.relay) {
      this.cache.delete(id);
      return;
    }
    const [projects, models] = await Promise.all([
      client.projects.recentFolders(100),
      client.request({ type: "models.list", limit: 100 }),
    ]);
    if (this.closed || projects.result.kind !== "recentFolders" || !("models" in models.result))
      return;
    const agents: RemoteAgentHost["agents"] = [];
    const permissions = new Map<string, Awaited<ReturnType<ClientApi["request"]>>>();
    for (const model of models.result.models.filter(
      (candidate) =>
        !candidate.hidden && !candidate.deprecated && candidate.providerEnabled !== false,
    )) {
      if (this.closed) return;
      const key = JSON.stringify([model.provider, model.instance, model.instanceId]);
      let reply = permissions.get(key);
      if (!reply) {
        reply = await client.request({
          type: "permissions.capabilities",
          provider: model.provider,
          instanceId: model.instanceId ?? model.instance,
        });
        permissions.set(key, reply);
      }
      if (
        reply.type !== "permissions.capabilities.result" ||
        !reply.ok ||
        !reply.permissions?.permissionModes?.length
      )
        continue;
      agents.push({
        provider: model.provider,
        model: model.id,
        accountId: model.instance,
        ...(model.acpAgentId ? { acpAgentId: model.acpAgentId } : {}),
        ...(model.installationId ? { installationId: model.installationId } : {}),
        ...(model.instanceId ? { instanceId: model.instanceId } : {}),
        permissionModes: reply.permissions.permissionModes,
      });
    }
    const state = this.pool.machine(id);
    if (this.closed || state?.status !== "online" || this.pool.client(id) !== client) return;
    const host = RemoteAgentHost.parse({
      hostId: HostId.parse(id),
      name: state.entry.displayName,
      projects: projects.result.folders.map((project) => ({
        workspaceId: project.id,
        name: project.name,
      })),
      agents,
    });
    this.cache.set(id, { client, at: this.now(), host });
  }
  private async work() {
    if (this.closed || this.primary.state !== "ready") return;
    const registration = await this.primary.request({
      type: "delegation.broker.register",
      hosts: this.hosts(),
    });
    if (this.closed || !registration.ok || !registration.lease) return;
    const lease = registration.lease;
    const reply = await this.primary.request({ type: "delegation.broker.poll", lease });
    if (!reply.ok || this.closed) return;
    const tasks = reply.tasks ?? [];
    const active = new Set(tasks.map((task) => task.id));
    for (const id of this.importFailures.keys())
      if (!active.has(id)) this.importFailures.delete(id);
    const after = this.cursor ? tasks.findIndex((task) => task.id === this.cursor) + 1 : 0;
    const ordered = [...tasks.slice(after), ...tasks.slice(0, after)].toSorted(
      (a, b) => Number(b.phase === "cancelling") - Number(a.phase === "cancelling"),
    );
    // Heartbeat/poll never waits for physical creation. One route per host keeps a slow
    // worktree from consuming every slot, while other hosts have independent workers.
    for (const task of ordered) {
      if (this.jobs.size >= 4) break;
      if (
        this.jobs.has(task.id) ||
        [...this.jobs.values()].some((job) => job.host === task.request.hostId)
      )
        continue;
      this.cursor = task.id;
      const work = this.route(task, lease)
        .catch(() => {})
        .finally(() => {
          this.jobs.delete(task.id);
        });
      this.jobs.set(task.id, { host: task.request.hostId, work });
    }
  }
  private report(lease: string, report: RemoteTaskReport) {
    return this.primary.request({ type: "delegation.broker.report", lease, report });
  }
  private async outcome(
    client: RemoteClient,
    task: RemoteTask,
    lease: string,
    reply: import("@ace/protocol").RemoteDelegationResult,
  ) {
    if (!reply.ok || !reply.phase) throw new ClientError("offline");
    if (["completed", "failed"].includes(reply.phase) && !reply.artifacts)
      throw new ClientError("protocol", "Remote device does not support sealed return manifests");
    let artifactsUnavailable = false;
    let importError: string | undefined;
    try {
      if (reply.artifacts)
        await returnRemoteArtifacts(
          task,
          reply.artifacts,
          lease,
          this.primary,
          client,
          (relay) => {
            if (!this.pool.contextRelay) throw new ClientError("offline");
            return this.pool.contextRelay(task.request.hostId, relay);
          },
          () =>
            !this.closed &&
            this.primary.state === "ready" &&
            this.pool.machine(task.request.hostId)?.status === "online",
        );
      this.importFailures.delete(task.id);
    } catch (error) {
      const failures = (this.importFailures.get(task.id) ?? 0) + 1;
      this.importFailures.set(task.id, failures);
      if (failures < 3 && task.phase !== "cancelling") throw error;
      artifactsUnavailable = true;
      importError = `Couldn't import: ${(reply.artifacts?.attachments.map((file) => file.name).join(", ") ?? "published files").slice(0, 120)}. The answer is preserved. Retrieve these files on the remote computer.`;
    }
    await this.report(lease, {
      taskId: task.id,
      ...(reply.truncated !== undefined ? { truncated: reply.truncated } : {}),
      ...(artifactsUnavailable ? { artifactsUnavailable: true, error: importError } : {}),
      phase: reply.phase === "queued" ? "running" : reply.phase,
      ...(reply.result !== undefined ? { result: reply.result } : {}),
      ...(reply.usage ? { usage: reply.usage } : {}),
      ...(reply.artifacts && !artifactsUnavailable ? { artifacts: reply.artifacts } : {}),
    });
  }
  private async route(task: RemoteTask, lease: string) {
    if (["completed", "failed", "cancelled"].includes(task.phase)) return;
    if (this.pool.machine(task.request.hostId)?.status !== "online") {
      await this.report(lease, { taskId: task.id, phase: "unavailable" });
      return;
    }
    const client = this.pool.client(task.request.hostId);
    try {
      if (task.phase === "cancelling") {
        await this.cancel(client, task, lease);
        return;
      }
      // Reconfirm authority/cancellation and the parent policy before remote admission.
      const accepted = await this.report(lease, { taskId: task.id, phase: "running" });
      if (!accepted.ok || this.closed) return;
      const current = accepted.tasks?.[0];
      if (current?.phase === "cancelling") {
        await this.cancel(client, current, lease);
        return;
      }
      const existing = await client.request({ type: "delegation.remote.status", taskId: task.id });
      if (existing.ok && existing.phase) {
        await this.outcome(client, task, lease, existing);
        return;
      }
      if (existing.error !== "not_found")
        throw new ClientError("offline", "Remote admission status unavailable");
      await transferRemoteContext(
        task,
        this.primary,
        client,
        (relay) => {
          if (!this.pool.contextRelay) throw new ClientError("offline");
          return this.pool.contextRelay(task.request.hostId, relay);
        },
        () => !this.closed && this.pool.machine(task.request.hostId)?.status === "online",
      );
      const confirmed = await this.report(lease, { taskId: task.id, phase: "running" });
      if (!confirmed.ok || this.closed) return;
      const latest = confirmed.tasks?.[0];
      if (!latest || ["completed", "failed", "cancelled"].includes(latest.phase)) return;
      if (latest.phase === "cancelling") {
        await this.cancel(client, latest, lease);
        return;
      }
      const result = await client.request({ type: "delegation.remote.start", task: latest });
      if (result.phase === "cancelled") {
        await this.report(lease, { taskId: task.id, phase: "cancelled" });
        return;
      }
      if (result.phase === "failed") {
        await this.report(lease, {
          taskId: task.id,
          phase: "failed",
          error: "Remote task admission failed",
        });
        return;
      }
      if (!result.ok) {
        await this.report(lease, {
          taskId: task.id,
          phase: "unavailable",
          error: "Remote admission unavailable",
        });
        return;
      }
      const status = await client.request({ type: "delegation.remote.status", taskId: task.id });
      if (status.ok && status.phase) await this.outcome(client, task, lease, status);
    } catch (error) {
      if (this.closed) return;
      await this.report(lease, {
        taskId: task.id,
        phase: "unavailable",
        error:
          error instanceof ClientError && error.code === "auth"
            ? "Remote device authorization unavailable"
            : "Remote device status unavailable",
      });
    }
  }
  private async cancel(client: RemoteClient, task: RemoteTask, lease: string) {
    const status = await client.request({ type: "delegation.remote.status", taskId: task.id });
    if (status.ok && ["completed", "failed"].includes(status.phase ?? "")) {
      await this.outcome(client, task, lease, status);
      // Preserve a sealed answer even if the source has already requested cancellation.
      await this.report(lease, {
        taskId: task.id,
        phase: "cancelled",
        result: status.result,
        truncated: status.truncated,
      });
      return;
    }
    const reply = await client.request({ type: "delegation.remote.cancel", taskId: task.id });
    if (reply.ok && ["completed", "failed"].includes(reply.phase ?? "")) {
      await this.outcome(client, task, lease, reply);
      await this.report(lease, {
        taskId: task.id,
        phase: "cancelled",
        result: reply.result,
        truncated: reply.truncated,
      });
      return;
    }
    if (reply.ok && reply.phase)
      await this.report(lease, {
        taskId: task.id,
        phase: reply.phase === "cancelled" ? "cancelled" : "cancelling",
      });
  }
}
