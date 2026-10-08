import { ProviderLoginRequest, ProviderLoginProgress } from "@ace/protocol";
import type { ProviderLoginInput, ProviderLoginResult, ProviderKind } from "@ace/protocol";

export type LoginUpdate = Pick<
  ProviderLoginProgress,
  "state" | "url" | "userCode" | "prompt" | "choices" | "message" | "hint" | "manual"
>;
export interface ProviderLoginDriver {
  manual?: ProviderLoginProgress["manual"];
  run(
    signal: AbortSignal,
    emit: (update: LoginUpdate) => void,
  ): Promise<{ success: boolean; manual?: ProviderLoginProgress["manual"] }>;
  input?(input: ProviderLoginInput): boolean;
  apiKey?(key: Buffer): boolean;
  drain?(): Promise<void>;
  changed?(signal: AbortSignal): Promise<void>;
  release?(): void;
}
export interface LoginSessionsOptions {
  now(): number;
  id(): string;
  schedule(callback: () => void, ms: number): () => void;
  prepare(
    target: {
      provider: ProviderKind;
      instance?: string;
      method?: "login" | "api_key";
      upstream?: "openai" | "anthropic" | "openrouter" | "opencode";
    },
    action: "login" | "logout",
    signal: AbortSignal,
    owner: string,
  ): Promise<ProviderLoginDriver>;
  lifetimeMs?: number;
  instanceKey?(provider: ProviderKind, instance?: string): string | undefined;
}
interface Job {
  owner: string;
  settled?: ((state: "succeeded" | "failed" | "cancelled") => Promise<void>) | undefined;
  upstream?: "openai" | "anthropic" | "openrouter" | "opencode";
  key: string;
  requestId: string;
  progress: ProviderLoginProgress;
  controller: AbortController;
  driver?: ProviderLoginDriver;
  done: Promise<void>;
  timer(): void;
  expired: boolean;
}
/** Ephemeral challenges belong to the authenticated device, never an event log or transcript. */
export class ProviderLoginSessions {
  private options: LoginSessionsOptions;
  private jobs = new Map<string, Job>();
  private active = new Map<string, Job>();
  private listeners = new Set<(owner: string, progress: ProviderLoginProgress) => void>();
  private closed = false;
  constructor(options: LoginSessionsOptions) {
    this.options = options;
  }
  listen(listener: (owner: string, progress: ProviderLoginProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  busy(provider: ProviderKind, instance?: string): boolean {
    return this.active.has(
      JSON.stringify([
        provider,
        this.options.instanceKey?.(provider, instance) ??
          (instance === `${provider}-cli-default` ? "default" : (instance ?? "default")),
      ]),
    );
  }
  async handle(
    owner: string,
    input: unknown,
    settled?: Job["settled"],
  ): Promise<ProviderLoginResult> {
    let request: ProviderLoginRequest | undefined;
    try {
      try {
        request = ProviderLoginRequest.parse(input);
      } catch {
        throw new Error("Invalid login request");
      }
      return await this.dispatch(owner, request, settled);
    } finally {
      if (request?.type === "provider.login.apiKey") request.apiKey = "";
      if (typeof input === "object" && input !== null && "apiKey" in input) input.apiKey = "";
    }
  }
  private async dispatch(
    owner: string,
    request: ProviderLoginRequest,
    settled?: Job["settled"],
  ): Promise<ProviderLoginResult> {
    const failure = (
      error: Extract<ProviderLoginResult["result"], { ok: false }>["error"],
    ): ProviderLoginResult => ({
      type: "provider.login.result",
      requestId: request.requestId,
      result: { ok: false, error },
    });
    const reply = (job: Job): ProviderLoginResult => ({
      type: "provider.login.result",
      requestId: request.requestId,
      result: { ok: true, progress: ProviderLoginProgress.parse(job.progress) },
    });
    if (this.closed) return failure("unavailable");
    if (request.type === "provider.login.start" || request.type === "provider.logout") {
      const key = JSON.stringify([
        request.provider,
        this.options.instanceKey?.(request.provider, request.instance) ??
          (request.instance === `${request.provider}-cli-default`
            ? "default"
            : (request.instance ?? "default")),
      ]);
      const retried = [...this.jobs.values()].find(
        (job) => job.owner === owner && job.key === key && job.requestId === request.requestId,
      );
      if (retried) return reply(retried);
      const existing = this.active.get(key);
      if (existing)
        return existing.owner === owner && existing.requestId === request.requestId
          ? reply(existing)
          : failure("busy");
      if (this.jobs.size >= 32) return failure("busy");
      const lifetime = this.options.lifetimeMs ?? 600_000;
      const session = this.options.id();
      const job: Job = {
        owner,
        ...(settled ? { settled } : {}),
        ...(request.type === "provider.login.start" && request.upstream
          ? { upstream: request.upstream }
          : {}),
        key,
        requestId: request.requestId,
        controller: new AbortController(),
        expired: false,
        progress: {
          session,
          provider: request.provider,
          ...(request.instance ? { instance: request.instance } : {}),
          action: request.type === "provider.logout" ? "logout" : "login",
          ...(request.type === "provider.login.start" ? { method: request.method ?? "login" } : {}),
          state: "starting",
          expiresAt: this.options.now() + lifetime,
          sequence: 0,
        },
        done: Promise.resolve(),
        timer: () => {},
      };
      this.jobs.set(session, job);
      this.active.set(key, job);
      job.timer = this.options.schedule(() => {
        job.expired = true;
        job.controller.abort();
        void job.done.then(async () => {
          if (this.active.get(job.key) === job) return;
          try {
            await job.settled?.("failed");
            job.settled = undefined;
            job.timer = this.options.schedule(() => this.jobs.delete(session), 60_000);
          } catch {
            this.active.set(job.key, job);
            this.emit(job, {
              state: "verifying",
              message: "Account cleanup needs attention. Retry cancellation.",
            });
          }
        });
      }, lifetime);
      // Install ownership before preparation can perform I/O or invoke a callback.
      job.done = Promise.resolve().then(() => this.run(job));
      return reply(job);
    }
    const job = this.jobs.get(request.session);
    if (!job) return failure("not_found");
    if (job.owner !== owner) return failure("forbidden");
    if (request.type === "provider.login.cancel") {
      if (this.active.get(job.key) === job) {
        job.controller.abort();
        await job.done;
        if (this.active.get(job.key) === job) {
          try {
            await job.driver?.drain?.();
          } catch {
            return failure("busy");
          }
          job.driver?.release?.();
          await job.settled?.("cancelled");
          job.settled = undefined;
          this.active.delete(job.key);
          this.emit(job, { state: "cancelled", message: "Sign-in cancelled." });
          if (job.expired) {
            job.timer();
            job.timer = this.options.schedule(() => this.jobs.delete(request.session), 60_000);
          }
        }
      } else if (job.settled) {
        await job.settled("cancelled");
        job.settled = undefined;
        this.emit(job, { state: "cancelled", message: "Sign-in cancelled." });
      }
    } else if (request.type === "provider.login.apiKey") {
      const key = Buffer.from(request.apiKey, "utf8");
      request.apiKey = "";
      let accepted = false;
      try {
        accepted =
          job.progress.state === "awaiting_api_key" && (job.driver?.apiKey?.(key) ?? false);
        if (!accepted) return failure("invalid_input");
      } finally {
        if (!accepted) key.fill(0);
      }
    } else if (request.type === "provider.login.input") {
      if (job.progress.state !== "awaiting_input" || !job.driver?.input?.(request.input))
        return failure("invalid_input");
    }
    return reply(job);
  }
  private emit(job: Job, update: LoginUpdate): void {
    job.progress = ProviderLoginProgress.parse({
      session: job.progress.session,
      provider: job.progress.provider,
      instance: job.progress.instance,
      action: job.progress.action,
      ...(job.progress.method ? { method: job.progress.method } : {}),
      expiresAt: job.progress.expiresAt,
      sequence: job.progress.sequence + 1,
      ...update,
    });
    for (const listener of this.listeners)
      listener(job.owner, ProviderLoginProgress.parse(job.progress));
  }
  private async run(job: Job): Promise<void> {
    const signal = job.controller.signal;
    let success = false;
    let manual: ProviderLoginProgress["manual"];
    try {
      signal.throwIfAborted();
      const driver = await this.options.prepare(
        {
          provider: job.progress.provider,
          ...(job.progress.method ? { method: job.progress.method } : {}),
          ...(job.upstream ? { upstream: job.upstream } : {}),
          ...(job.progress.instance ? { instance: job.progress.instance } : {}),
        },
        job.progress.action,
        signal,
        job.owner,
      );
      job.driver = driver;
      manual = driver.manual;
      signal.throwIfAborted();
      const result = await driver.run(signal, (update) => {
        if (!signal.aborted) this.emit(job, update);
      });
      await driver.drain?.();
      signal.throwIfAborted();
      manual = result.manual ?? manual;
      if (result.success) {
        this.emit(job, { state: "verifying" });
        await driver.changed?.(signal);
        signal.throwIfAborted();
        success = true;
      }
    } catch {
      // Exceptions and CLI diagnostics may contain credentials. Publish categories only.
    }
    try {
      await job.driver?.drain?.();
    } catch {
      this.emit(job, {
        state: "verifying",
        message: "CLI cleanup needs attention. Retry cancellation before starting another login.",
      });
      return;
    }
    job.driver?.release?.();
    const state = signal.aborted
      ? job.expired
        ? "failed"
        : "cancelled"
      : success
        ? "succeeded"
        : "failed";
    try {
      // A manual fallback still owns the staged home until its terminal finishes or is cancelled.
      if (state !== "failed" || !manual || signal.aborted) {
        await job.settled?.(state);
        job.settled = undefined;
      }
    } catch {
      this.emit(job, {
        state: "verifying",
        message: "Account cleanup needs attention. Retry cancellation.",
      });
      return;
    }
    this.active.delete(job.key);
    this.emit(
      job,
      signal.aborted
        ? {
            state: job.expired ? "failed" : "cancelled",
            message: job.expired ? "Sign-in timed out. Try again." : "Sign-in cancelled.",
            ...(job.expired && manual ? { manual, hint: manual.instruction } : {}),
          }
        : {
            state: success ? "succeeded" : "failed",
            ...(!success && manual ? { manual, hint: manual.instruction } : {}),
            message: success
              ? "Provider authentication updated."
              : "Provider authentication could not be completed.",
          },
    );
  }

  async completed(owner: string, session: string): Promise<ProviderLoginProgress> {
    const job = this.jobs.get(session);
    if (!job || job.owner !== owner) throw new Error("Unknown login");
    await job.done;
    return ProviderLoginProgress.parse(job.progress);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) {
      job.timer();
      job.controller.abort();
    }
    await Promise.all([...this.jobs.values()].map((job) => job.done));
    for (const job of this.active.values()) {
      await job.driver?.drain?.();
      job.driver?.release?.();
    }
    for (const job of this.jobs.values()) await job.settled?.("cancelled");
    this.active.clear();
    this.jobs.clear();
    this.listeners.clear();
  }
}
