import { NativeAccountProvider } from "@ace/protocol/accounts";
import type { z } from "zod";
import type { ClientApi } from "@ace/client";
import type {
  ProviderKind,
  ProviderLoginInput,
  ProviderLoginProgress,
  ApiKeyUpstream,
} from "@ace/protocol";

/*
 * One sign-in (or sign-out) with a provider's own CLI, as the daemon supervises it
 * (docs/daemon/provider-login.md). Started from a click, not an effect, so a remount never
 * starts a second login; closed by `dispose`, which cancels a login still running. React reads
 * it through `subscribe` / `view`.
 */

export interface SignInTarget {
  provider: ProviderKind;
  /** Create a named account and authenticate it in one daemon-owned operation. */
  newAccount?: string | undefined;
  name?: string | undefined;
  /** A managed ace account; omitted for the CLI's normal profile. */
  instance?: string | undefined;
  /** The upstream to pick when the CLI asks (an OpenCode or Pi source such as "opencode-go"). */
  choice?: string | undefined;
  /** That upstream's name ("OpenAI"), for the dialog's title: Connect OpenAI, Disconnect OpenAI. */
  service?: string | undefined;
  action?: "login" | "logout" | undefined;
  method?: "login" | "api_key" | undefined;
  upstream?: z.infer<typeof ApiKeyUpstream> | undefined;
}

/** Why the daemon wouldn't start or continue, or "offline" when it couldn't be asked. */
export type LoginRefusal =
  | "forbidden"
  | "unavailable"
  | "busy"
  | "not_found"
  | "invalid_input"
  | "offline";

export type LoginView =
  | { kind: "requesting" }
  | { kind: "refused"; reason: LoginRefusal }
  | {
      kind: "progress";
      progress: ProviderLoginProgress;
      /** An input the daemon turned down; the session goes on. */
      refused?: LoginRefusal | undefined;
      /** A request is on its way (an answer, a cancel, opening the terminal). */
      sending?: boolean | undefined;
    };

type SessionRequest =
  | {
      type: "provider.login.poll" | "provider.login.cancel" | "provider.login.terminal";
      session: string;
    }
  | { type: "provider.login.input"; session: string; input: ProviderLoginInput }
  | { type: "provider.login.apiKey"; session: string; apiKey: string };

const finished = new Set<ProviderLoginProgress["state"]>(["succeeded", "failed", "cancelled"]);

/** The session reached an end: signed in (or out), failed or cancelled. */
export const isFinished = (progress: ProviderLoginProgress): boolean =>
  finished.has(progress.state);

export class LoginController {
  readonly target: SignInTarget;
  private client: ClientApi;
  private current: LoginView = { kind: "requesting" };
  private listeners = new Set<() => void>();
  private session: string | undefined;
  /** Snapshots that raced the start reply, by session. */
  private early = new Map<string, ProviderLoginProgress>();
  private chose = false;
  private openedPage = false;
  private announced = false;

  /** Dialog and inline readers can observe the same reply; only one owns its confirmation. */
  claimCompletion(): boolean {
    if (
      this.announced ||
      this.current.kind !== "progress" ||
      this.current.progress.state !== "succeeded"
    )
      return false;
    this.announced = true;
    return true;
  }
  private stops: (() => void)[] = [];
  private disposed = false;

  constructor(client: ClientApi, target: SignInTarget) {
    this.client = client;
    this.target = target;
    // Attached before starting: a progress push can arrive before the start reply.
    this.stops.push(
      client.onMessage((message) => {
        if (message.type === "provider.login.progress") this.accept(message.progress);
      }),
    );
    const connection = client.connectionState();
    let ready = connection.getSnapshot() === "ready";
    this.stops.push(
      connection.subscribe(() => {
        const now = connection.getSnapshot() === "ready";
        // Back after a drop: polling reattaches this socket for the session's pushes.
        if (now && !ready && this.session && !this.done)
          void this.ask({ type: "provider.login.poll", session: this.session });
        ready = now;
      }),
    );
    void this.start();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The step shown now (`useSyncExternalStore`'s snapshot). */
  getView = (): LoginView => this.current;

  /** Pick one of the choices the CLI offered. */
  choose(choice: string): void {
    this.input({ choice });
  }

  /** Answer the CLI's fixed prompt with Enter. */
  continue(): void {
    this.input({ value: "enter" });
  }

  /** The dedicated ephemeral path; the request and field are cleared after hand-off. */
  submitApiKey(apiKey: string): void {
    if (
      !this.session ||
      this.current.kind !== "progress" ||
      this.current.progress.state !== "awaiting_api_key"
    )
      return;
    void this.ask({ type: "provider.login.apiKey", session: this.session, apiKey });
  }

  /** True only the first time: a sign-in opens its page by itself at most once. */
  claimPageOpen(): boolean {
    if (this.openedPage) return false;
    this.openedPage = true;
    return true;
  }

  cancel(): void {
    if (!this.session || this.done) return;
    void this.ask({ type: "provider.login.cancel", session: this.session });
  }

  /** Start the CLI's own sign-in in an ace terminal; its id once the daemon has one. */
  async openTerminal(): Promise<string | undefined> {
    const session = this.session;
    if (!session) return undefined;
    const progress = await this.ask({ type: "provider.login.terminal", session });
    return progress?.manual?.terminalId;
  }

  /** Stop listening; a login still running is cancelled, since nobody can finish it here. */
  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    for (const stop of this.stops.splice(0)) stop();
    this.listeners.clear();
  }

  private get done(): boolean {
    return (
      this.current.kind === "progress" &&
      isFinished(this.current.progress) &&
      !(
        this.target.newAccount &&
        this.current.progress.state === "failed" &&
        this.current.progress.manual
      )
    );
  }

  private async start(): Promise<void> {
    const { provider, instance, action, method, upstream, newAccount } = this.target;
    try {
      const target = { provider, ...(instance ? { instance } : {}) };
      const reply = newAccount
        ? await this.client.request({
            type: "provider.accounts.add",
            provider: NativeAccountProvider.parse(provider),
            label: newAccount,
            method: method ?? "login",
            ...(upstream ? { upstream } : {}),
          })
        : action === "logout"
          ? await this.client.request({ type: "provider.logout", ...target })
          : await this.client.request({
              type: "provider.login.start",
              ...target,
              ...(method ? { method } : {}),
              ...(upstream ? { upstream } : {}),
            });
      if (!reply.result.ok)
        return this.set({
          kind: "refused",
          reason:
            reply.result.error === "unsupported" || reply.result.error === "failed"
              ? "unavailable"
              : reply.result.error,
        });
      const { progress } = reply.result;
      if (!progress) return this.set({ kind: "refused", reason: "unavailable" });
      this.session = progress.session;
      if (this.disposed) {
        // Closed before the daemon answered: end what it started.
        void this.client
          .request({ type: "provider.login.cancel", session: progress.session })
          .catch(() => {});
        return;
      }
      this.accept(progress);
      const raced = this.early.get(progress.session);
      this.early.clear();
      if (raced) this.accept(raced);
    } catch {
      this.set({ kind: "refused", reason: "offline" });
    }
  }

  private input(input: ProviderLoginInput): void {
    if (!this.session || this.done) return;
    void this.ask({ type: "provider.login.input", session: this.session, input });
  }

  /** A request about this session; its reply is a snapshot like any push. */
  private async ask(request: SessionRequest): Promise<ProviderLoginProgress | undefined> {
    this.patch({ sending: true, refused: undefined });
    try {
      const reply = await this.client.request(request);
      if (!reply.result.ok) {
        this.patch({ refused: reply.result.error });
        return undefined;
      }
      this.accept(reply.result.progress, true);
      return reply.result.progress;
    } catch {
      this.patch({ refused: "offline" });
      return undefined;
    } finally {
      if (request.type === "provider.login.apiKey") request.apiKey = "";
      this.patch({ sending: false });
    }
  }

  /** A snapshot for this session, newer than the one shown (older ones are dropped). */
  private accept(progress: ProviderLoginProgress, replace = false): void {
    if (this.disposed) return;
    if (!this.session) {
      const known = this.early.get(progress.session);
      if (!known || known.sequence < progress.sequence) this.early.set(progress.session, progress);
      return;
    }
    if (progress.session !== this.session) return;
    const shown = this.current.kind === "progress" ? this.current.progress : undefined;
    if (
      shown &&
      (replace ? progress.sequence < shown.sequence : progress.sequence <= shown.sequence)
    )
      return;
    this.set({ kind: "progress", progress });
    this.autoChoose(progress);
  }

  /** Signing in to one upstream: pick it as soon as the CLI offers it, once. */
  private autoChoose(progress: ProviderLoginProgress): void {
    const wanted = this.target.choice;
    if (this.chose || !wanted || progress.state !== "awaiting_input") return;
    if (!progress.choices?.some((choice) => choice.id === wanted)) return;
    this.chose = true;
    this.choose(wanted);
  }

  private patch(update: { refused?: LoginRefusal | undefined; sending?: boolean }): void {
    if (this.current.kind !== "progress" || this.disposed) return;
    this.set({ ...this.current, ...update });
  }

  private set(view: LoginView): void {
    if (this.disposed) return;
    this.current = view;
    for (const listener of this.listeners) listener();
  }
}
