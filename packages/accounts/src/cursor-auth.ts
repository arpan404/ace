import { CursorAuthRequest, CursorAuthEvent } from "@ace/protocol";
import { CursorSdkUnavailableError } from "@ace/adapter-cursor";
import type { ProviderInstance, CursorSdkAuth } from "@ace/protocol/accounts";
import type { z } from "zod";
import type { AccountRegistry } from "./registry.ts";

type Auth = z.infer<typeof CursorSdkAuth>;
interface Driver {
  checkAvailability?(): Promise<void>;
  status(instance: ProviderInstance, signal: AbortSignal): Promise<Auth>;
  login(
    instance: ProviderInstance,
    signal: AbortSignal,
    url: (value: string) => void,
  ): Promise<Auth>;
  logout(instance: ProviderInstance, signal: AbortSignal): Promise<Auth>;
}
interface Job {
  id: string;
  owner: string;
  requestId: string;
  instanceId: string;
  expiresAt: number;
  state: "starting" | "browser" | "complete" | "failed" | "cancelled";
  url?: string | undefined;
  auth?: Auth;
  controller: AbortController;
  done: Promise<void>;
  cancelTimer(): void;
}
export interface CursorAuthOptions {
  registry: AccountRegistry;
  driver: Driver;
  now(): number;
  id(): string;
  setTimer(callback: () => void, delay: number): () => void;
  createInstance(id: string, label: string): Promise<ProviderInstance>;
  rebindInstance(id: string): Promise<void>;
  authChanged?(instance: ProviderInstance, auth: Auth): Promise<void>;
}

/** Login challenges belong to a paired device, only in bounded ephemeral memory. */
export class CursorAuthService {
  private options: CursorAuthOptions;
  private jobs = new Map<string, Job>();
  private busy = new Set<string>();
  private closed = false;
  private lifetime = new AbortController();
  private requests = new Set<Promise<CursorAuthEvent>>();
  constructor(options: CursorAuthOptions) {
    this.options = options;
  }
  private account(id: string): ProviderInstance | undefined {
    const instance = this.options.registry.get(id)?.instance;
    return instance?.provider === "cursor" ? instance : undefined;
  }
  private event(requestId: string, job: Job): CursorAuthEvent {
    return CursorAuthEvent.parse({
      type: "cursor.auth.login",
      requestId,
      loginId: job.id,
      instanceId: job.instanceId,
      state: job.state,
      expiresAt: job.expiresAt,
      ...(job.state === "browser" && job.url ? { url: job.url } : {}),
      ...(job.auth ? { auth: job.auth } : {}),
      ...(job.state === "failed" ? { error: "login_failed" } : {}),
      ...(job.state === "cancelled" ? { error: "cancelled" } : {}),
    });
  }
  handle(owner: string, input: unknown): Promise<CursorAuthEvent> {
    const request = CursorAuthRequest.parse(input);
    if (this.requests.size >= 16)
      return Promise.resolve({
        type: "cursor.auth.error",
        requestId: request.requestId,
        code: "busy",
      });
    const task = this.execute(owner, request);
    this.requests.add(task);
    void task.finally(() => this.requests.delete(task));
    return task;
  }
  private async execute(owner: string, input: CursorAuthRequest): Promise<CursorAuthEvent> {
    const request = CursorAuthRequest.parse(input);
    const error = (
      code: "busy" | "not_found" | "forbidden" | "auth_failed" | "unavailable",
      reason?: Extract<CursorAuthEvent, { type: "cursor.auth.error" }>["reason"],
    ): CursorAuthEvent => ({
      type: "cursor.auth.error",
      requestId: request.requestId,
      code,
      ...(reason ? { reason } : {}),
    });
    if (this.closed) return error("unavailable", "service_unavailable");
    try {
      if (request.type === "cursor.auth.poll" || request.type === "cursor.auth.cancel") {
        const job = this.jobs.get(request.loginId);
        if (!job) return error("not_found");
        if (job.owner !== owner) return error("forbidden");
        if (request.type === "cursor.auth.cancel") await this.cancel(job);
        return this.event(request.requestId, job);
      }
      if (this.busy.has(request.instanceId)) return error("busy");
      if (request.type === "cursor.auth.start") {
        for (const job of this.jobs.values())
          if (
            job.instanceId === request.instanceId &&
            (["starting", "browser"].includes(job.state) ||
              (job.owner === owner && job.requestId === request.requestId))
          )
            return job.owner === owner ? this.event(request.requestId, job) : error("busy");
        if (this.jobs.size >= 8) return error("busy");
      }
      if (request.type === "cursor.auth.status" || request.type === "cursor.auth.select")
        for (const job of this.jobs.values())
          if (job.instanceId === request.instanceId && ["starting", "browser"].includes(job.state))
            return error("busy");
      this.busy.add(request.instanceId);
      try {
        if (
          request.type === "cursor.auth.start" &&
          !this.options.registry.get(request.instanceId)
        ) {
          const instance = await this.options.createInstance(
            request.instanceId,
            request.label ?? request.instanceId,
          );
          await this.options.registry.register(instance);
        }
        const instance = this.account(request.instanceId);
        if (!instance) return error("unavailable", "instance_unavailable");
        this.lifetime.signal.throwIfAborted();
        if (request.type === "cursor.auth.start") {
          if (this.jobs.size >= 8) return error("busy");
          await this.options.driver.checkAvailability?.();
          this.lifetime.signal.throwIfAborted();
          return this.start(owner, request.requestId, instance);
        }
        if (request.type === "cursor.auth.logout") {
          for (const job of this.jobs.values())
            if (job.instanceId === instance.id) await this.cancel(job);
        }
        const controller = this.lifetime;
        const auth =
          request.type === "cursor.auth.logout"
            ? await this.options.driver.logout(instance, controller.signal)
            : await this.options.driver.status(instance, controller.signal);
        if (request.type === "cursor.auth.select") {
          if (auth.status !== "logged-in") return error("auth_failed");
          await this.options.rebindInstance(instance.id);
          await this.options.authChanged?.(instance, auth);
          this.options.registry.selectCursorSdk(instance.id);
        }
        if (request.type === "cursor.auth.logout") await this.options.authChanged?.(instance, auth);
        if (
          request.type === "cursor.auth.logout" &&
          this.options.registry.selectedCursorSdk() === instance.id
        )
          this.options.registry.selectCursorSdk(undefined);
        return CursorAuthEvent.parse({
          type: "cursor.auth.changed",
          requestId: request.requestId,
          instanceId: instance.id,
          selectedInstanceId: this.options.registry.selectedCursorSdk() ?? null,
          auth,
        });
      } finally {
        this.busy.delete(request.instanceId);
      }
    } catch (cause) {
      if (this.closed) return error("unavailable", "service_unavailable");
      if (cause instanceof CursorSdkUnavailableError)
        return error("unavailable", "sdk_unavailable");
      return error("auth_failed");
    }
  }
  private start(owner: string, requestId: string, instance: ProviderInstance): CursorAuthEvent {
    const job: Job = {
      id: this.options.id(),
      owner,
      requestId,
      instanceId: instance.id,
      expiresAt: this.options.now() + 300000,
      state: "starting",
      controller: new AbortController(),
      done: Promise.resolve(),
      cancelTimer: () => {},
    };
    if (this.jobs.has(job.id)) throw new Error("Duplicate login identity");
    this.jobs.set(job.id, job);
    job.cancelTimer = this.options.setTimer(() => {
      void this.cancel(job).finally(() => this.jobs.delete(job.id));
    }, 300000);
    job.done = Promise.resolve()
      .then(async () => {
        job.auth = await this.options.driver.login(instance, job.controller.signal, (url) => {
          if (job.controller.signal.aborted || this.closed) return;
          const event = CursorAuthEvent.parse({
            type: "cursor.auth.login",
            requestId,
            loginId: job.id,
            instanceId: instance.id,
            state: "browser",
            expiresAt: job.expiresAt,
            url,
          });
          if (event.type === "cursor.auth.login") {
            job.url = event.url;
            job.state = "browser";
          }
        });
        if (!job.controller.signal.aborted) {
          await this.options.rebindInstance(instance.id);
          if (!job.controller.signal.aborted && job.auth)
            await this.options.authChanged?.(instance, job.auth);
          if (!job.controller.signal.aborted) job.state = "complete";
        }
      })
      .catch(() => {
        if (!job.controller.signal.aborted) job.state = "failed";
      })
      .finally(() => {
        job.url = undefined;
      });
    return this.event(requestId, job);
  }
  private async cancel(job: Job): Promise<void> {
    if (job.state === "starting" || job.state === "browser") {
      job.state = "cancelled";
      job.url = undefined;
      job.controller.abort();
    }
    await job.done;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    await Promise.all(
      [...this.jobs.values()].map(async (job) => {
        job.cancelTimer();
        await this.cancel(job);
      }),
    );
    this.jobs.clear();
    await Promise.allSettled(this.requests);
  }
}
