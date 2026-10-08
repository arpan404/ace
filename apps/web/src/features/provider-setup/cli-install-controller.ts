import type { ClientApi } from "@ace/client";
import type {
  InstallAction,
  InstallAgent,
  InstallMethod,
  ProviderInstallPlan,
  ProviderInstallProgress,
  ProviderKind,
} from "@ace/protocol";

export type InstallView =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "plan"; plan: ProviderInstallPlan }
  | { kind: "progress"; progress: ProviderInstallProgress }
  | { kind: "error"; message: string };

const done = (progress: ProviderInstallProgress) =>
  ["succeeded", "failed", "cancelled", "needs_admin"].includes(progress.state);

/** The socket owns the install job; reconnect polls it without starting another installer. */
export class CliInstallController {
  private view: InstallView = { kind: "idle" };
  private listeners = new Set<() => void>();
  private stops: (() => void)[] = [];
  private session: string | undefined;
  private starting = false;
  private early: ProviderInstallProgress | undefined;
  private disposed = false;
  private planning: AbortController | undefined;
  private cancelStarting = false;
  private client: ClientApi;
  private remember: (session: string | undefined) => void;
  private target: { provider: ProviderKind; agent?: InstallAgent; acpAgentId?: string };

  constructor(
    client: ClientApi,
    target: { provider: ProviderKind; agent?: InstallAgent; acpAgentId?: string },
    recovery: {
      session?: string | undefined;
      remember(session: string | undefined): void;
    },
  ) {
    this.client = client;
    this.target = target;
    this.remember = recovery.remember;
    this.session = recovery.session;
    if (this.session) this.view = { kind: "loading" };
  }
  start(): void {
    this.disposed = false;
    const client = this.client;
    const connection = client.connectionState();
    let ready = connection.getSnapshot() === "ready";
    this.stops = [
      client.onMessage((message) => {
        if (message.type === "provider.install.progress") this.accept(message.progress);
      }),
      connection.subscribe(() => {
        const next = connection.getSnapshot() === "ready";
        if (next && !ready && this.session) void this.poll();
        ready = next;
      }),
    ];
    if (this.session) {
      this.view = { kind: "loading" };
      if (ready) void this.poll();
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getView = () => this.view;
  async install(action: InstallAction): Promise<void> {
    await this.plan(action);
    if (this.disposed) return;
    const view = this.view;
    if (
      view.kind === "plan" &&
      view.plan.status === "ready" &&
      !view.plan.needsAdmin &&
      view.plan.method
    )
      await this.run(action, view.plan.method);
  }
  async plan(action: InstallAction): Promise<void> {
    this.planning?.abort();
    const controller = new AbortController();
    this.planning = controller;
    this.set({ kind: "loading" });
    try {
      const reply = await this.client.request(
        {
          type: "provider.install.plan",
          ...this.target,
          action,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      this.set(
        reply.result.ok && "plan" in reply.result
          ? { kind: "plan", plan: reply.result.plan }
          : {
              kind: "error",
              message: "Couldn't prepare the installer. Check your connection and try again.",
            },
      );
    } catch {
      if (!controller.signal.aborted) this.fail();
    } finally {
      if (this.planning === controller) this.planning = undefined;
    }
  }
  async run(action: InstallAction, method: InstallMethod): Promise<void> {
    this.starting = true;
    this.cancelStarting = false;
    this.early = undefined;
    this.session = undefined;
    this.set({ kind: "loading" });
    try {
      const reply = await this.client.request({
        type: "provider.install.run",
        ...this.target,
        action,
        method,
      });
      if (!reply.result.ok || !("progress" in reply.result)) {
        this.set({
          kind: "error",
          message: "Couldn't start the installer. Another installation may be running. Try again.",
        });
        return;
      }
      this.session = reply.result.progress.session;
      this.remember(this.session);
      this.accept(reply.result.progress);
      if (this.early) this.accept(this.early);
      if (this.cancelStarting) await this.cancel();
    } catch {
      this.fail();
    } finally {
      this.starting = false;
      this.early = undefined;
    }
  }
  async cancel(): Promise<void> {
    if (!this.session) {
      this.planning?.abort();
      this.cancelStarting = this.starting;
      this.set({ kind: "idle" });
      return;
    }
    try {
      const reply = await this.client.request({
        type: "provider.install.cancel",
        session: this.session,
      });
      if (reply.result.ok && "progress" in reply.result) this.accept(reply.result.progress);
      else this.fail();
    } catch {
      this.fail();
    }
  }
  close(): void {
    if (this.session) void this.poll();
    else this.set({ kind: "idle" });
  }
  dispose(): void {
    this.disposed = true;
    this.planning?.abort();
    for (const stop of this.stops) stop();
    this.listeners.clear();
  }
  private async poll(): Promise<void> {
    if (!this.session) return;
    try {
      const reply = await this.client.request({
        type: "provider.install.poll",
        session: this.session,
      });
      if (reply.result.ok && "progress" in reply.result) this.accept(reply.result.progress);
      else {
        this.session = undefined;
        this.remember(undefined);
        this.set({
          kind: "error",
          message: "This installation is no longer available. Check for updates or try again.",
        });
      }
    } catch {
      this.fail();
    }
  }
  private accept(progress: ProviderInstallProgress): void {
    if (
      progress.provider !== this.target.provider ||
      progress.agent !== this.target.agent ||
      progress.acpAgentId !== this.target.acpAgentId
    )
      return;
    if (!this.session) {
      if (this.starting && (!this.early || this.early.sequence < progress.sequence))
        this.early = progress;
      return;
    }
    if (progress.session !== this.session) return;
    if (this.view.kind === "progress" && this.view.progress.sequence >= progress.sequence) return;
    this.set({ kind: "progress", progress });
    if (done(progress)) {
      this.session = undefined;
      this.remember(undefined);
    }
  }
  private fail(): void {
    this.set({
      kind: "error",
      message: "Couldn't reach this computer. Reconnect to check the installation.",
    });
  }
  private set(view: InstallView): void {
    if (this.disposed) return;
    this.view = view;
    for (const listener of this.listeners) listener();
  }
}
