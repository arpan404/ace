import { inspectAccountSupport, reportedAuthMethod } from "./provider-account-support.ts";
import type { SdkDiscoveryOptions } from "@ace/provider-kit/sdk";
import { cursorInstanceId } from "@ace/provider-kit/cursor-selection";
import { fileURLToPath } from "node:url";
import {
  AccountManagementRequest,
  type AccountsResponse,
  type ProviderInstance,
} from "@ace/protocol/accounts";
import type { OpenTerminalOptions, TerminalEvent } from "@ace/terminal";
import {
  createPosixBackendFactory,
  TerminalManager,
  type LiveTerminal,
  type TerminalManagerOptions,
} from "@ace/terminal";
import {
  assertManagedHome,
  instanceEnv,
  loginStatus,
  logoutArgs,
  type AccountRegistry,
  type AccountService,
} from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { defaultProviderExecutable, type DiscoveryOptions } from "@ace/provider-kit/discovery";
import { createManagedHome, deleteManagedHome, registerImplicitAccounts } from "./account-homes.ts";
import type { ModelCatalog } from "@ace/models";

interface AuthTerminal {
  cancelTimer?: () => void;
  starting?: boolean;
  exited?: boolean;
  startup?: Promise<void>;
  controller: AbortController;
  sdk?: boolean;
  owner: string;
  instance?: ProviderInstance;
  launch?: OpenTerminalOptions;
  complete?: (success: boolean) => void;
  action: "login" | "logout";
  scope?: "operate";
  release(): void;
  terminal?: LiveTerminal;
  done?: Promise<void>;
}
export interface AccountManagementOptions {
  registry: AccountRegistry;
  accounts: AccountService;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  now(): number;
  id(): string;
  models(): ModelCatalog | undefined;
  cursor?():
    | {
        fence(id: string): Promise<void>;
        rebind(id: string): Promise<void>;
        status(instance: ProviderInstance): Promise<"logged_in" | "logged_out">;
        env: NodeJS.ProcessEnv;
        busy(id: string): boolean;
      }
    | undefined;
  authChanged?(): Promise<void>;
  configuration?(provider: ProviderInstance["provider"]): {
    enabled?: boolean | undefined;
    binaryPath?: string | undefined;
  };
  signal?: AbortSignal | undefined;
  discovery?: DiscoveryOptions | undefined;
  cursorDiscovery?: SdkDiscoveryOptions | undefined;
  terminal?: TerminalManagerOptions | undefined;
}

/** Host-local account changes. Provider auth output has no persistence or replay path. */
export class AccountManagement {
  private options: AccountManagementOptions;
  private manager: TerminalManager;
  private terminals = new Map<string, AuthTerminal>();
  private closed = false;
  private restorations = new Set<Promise<void>>();
  constructor(options: AccountManagementOptions) {
    this.options = options;
    this.manager = new TerminalManager({
      ...options.terminal,
      dependencies: {
        backendFactory: createPosixBackendFactory(undefined, options.dataDir),
        ...options.terminal?.dependencies,
      },
    });
  }
  async initialize(): Promise<void> {
    await this.options.registry.ready;
    for (const { instance } of this.options.registry.pendingInstances())
      await this.discardPending(instance.id);
    await registerImplicitAccounts(this.options.registry, this.options.env);
    // Restore isolated catalog identities on restart, using only read-only metadata probes.
    for (const { instance, quota } of this.options.registry.list())
      if (instance.managed && !quota.blockers.homeUnavailable) {
        this.options.signal?.throwIfAborted();
        await assertManagedHome(this.options.dataDir, instance);
        const sdk = instance.provider === "cursor" ? this.options.cursor?.() : undefined;
        if (instance.provider === "cursor" && !sdk) continue;
        const env = instanceEnv(
          instance,
          sdk?.env ?? this.options.env,
          sdk ? "cursor-sdk" : undefined,
        );
        if (
          this.options.registry.get(instance.id)?.quota.auth !== "logged_out" &&
          instance.provider !== "acp"
        ) {
          const executable =
            instance.provider === "pi"
              ? defaultProviderExecutable(instance.provider)
              : (this.options.discovery?.overrides?.[instance.provider] ??
                defaultProviderExecutable(instance.provider));
          this.registerCatalog(instance, sdk !== undefined, executable, env);
        }
        const refresh = this.refresh(instance);
        this.restorations.add(refresh);
        void refresh.catch(() => {}).finally(() => this.restorations.delete(refresh));
      }
  }
  async addPending(
    provider: ProviderInstance["provider"],
    label: string,
    shortLabel?: string,
  ): Promise<string> {
    const id = `account-${this.options.id()}`;
    const instance = await createManagedHome(this.options.dataDir, id, provider, label);
    try {
      await this.options.registry.registerPending({
        ...instance,
        ...(shortLabel === undefined ? {} : { shortLabel }),
      });
    } catch (error) {
      await deleteManagedHome(this.options.dataDir, instance);
      throw error;
    }
    return id;
  }
  async finishPending(id: string, state: "succeeded" | "failed" | "cancelled"): Promise<void> {
    if (!this.options.registry.isPending(id)) return;
    if (state === "succeeded") this.options.registry.publishAccount(id);
    else {
      for (const [terminalId, entry] of this.terminals)
        if (entry.instance?.id === id) {
          entry.controller.abort(new Error("Sign-in cancelled"));
          await this.stop(terminalId, entry.owner);
        }
      if (this.options.registry.isPending(id)) await this.discardPending(id);
    }
  }
  private async discardPending(id: string): Promise<void> {
    const instance = this.account(id);
    await this.options.models()?.removeInstance(id);
    await deleteManagedHome(this.options.dataDir, instance);
    this.options.registry.unregister(id);
  }
  summaries(provider: ProviderInstance["provider"]) {
    return this.options.registry
      .summaries(this.options.now())
      .filter((account) => account.provider === provider);
  }
  providerOf(instanceId: string) {
    return this.options.registry.get(instanceId)?.instance.provider;
  }
  apiKeySupport(provider: ProviderInstance["provider"]) {
    return inspectAccountSupport(provider, this.options);
  }
  private account(id: string): ProviderInstance {
    const instance = this.options.registry.get(id)?.instance;
    if (!instance) throw new Error("Unknown account");
    return instance;
  }
  private editable(id: string): ProviderInstance {
    const instance = this.account(id);
    if (instance.implicit || instance.provider === "acp") throw new Error("Account is immutable");
    return instance;
  }
  async handle(owner: string, input: unknown): Promise<AccountsResponse> {
    if (this.closed) throw new Error("Accounts closed");
    const request = AccountManagementRequest.parse(input);
    const { registry, accounts, now } = this.options;
    const changed = (id?: string): AccountsResponse => ({
      type: "accounts.changed",
      requestId: request.requestId,
      account: id ? (registry.summary(id, now()) ?? null) : null,
    });
    if (request.type === "accounts.add") {
      const id = `account-${this.options.id()}`;
      const instance = await createManagedHome(
        this.options.dataDir,
        id,
        request.provider,
        request.label,
      );
      try {
        await registry.register({
          ...instance,
          ...(request.shortLabel === undefined ? {} : { shortLabel: request.shortLabel }),
        });
      } catch (error) {
        await deleteManagedHome(this.options.dataDir, instance);
        throw error;
      }
      return changed(id);
    }
    if (request.type === "accounts.setDefault") {
      const instanceId =
        (request.provider === "cursor"
          ? cursorInstanceId(request.instanceId)
          : request.instanceId) ?? request.instanceId;
      if (this.account(instanceId).provider !== request.provider)
        throw new Error("Provider mismatch");
      registry.selectProvider(request.provider, instanceId);
      return changed(instanceId);
    }
    const instance = this.editable(request.instanceId);
    if (request.type === "accounts.rename") {
      registry.rename(instance.id, request.label, request);
      return changed(instance.id);
    }
    if (instance.provider === "cursor" && this.options.cursor?.()?.busy(instance.id))
      throw new Error("Instance is busy");
    const release = accounts.reserveAccountChange(instance.id);
    if (request.type === "accounts.login" || request.type === "accounts.logout") {
      if (!instance.managed) {
        release();
        throw new Error("Login requires a daemon-managed home");
      }
      try {
        if (this.terminals.size >= 8) throw new Error("Auth terminal capacity reached");
        const terminalId = this.options.id();
        this.terminals.set(terminalId, {
          owner,
          controller: new AbortController(),
          instance,
          action: request.type === "accounts.login" ? "login" : "logout",
          release,
        });
        return {
          type: "accounts.auth",
          requestId: request.requestId,
          instanceId: instance.id,
          terminalId,
          ...(instance.provider === "pi"
            ? { instruction: request.type === "accounts.login" ? "/login" : "/logout" }
            : {}),
        };
      } catch (error) {
        release();
        throw error;
      }
    }
    try {
      if (instance.provider === "cursor") await this.options.cursor?.()?.fence(instance.id);
      // Catalog cancellation completes before a private home can be removed.
      await this.options.models()?.removeInstance(instance.id);
      if (request.deleteHome) await deleteManagedHome(this.options.dataDir, instance);
      registry.unregister(instance.id);
      return changed();
    } finally {
      release();
    }
  }
  /** The provider-login fallback may use the normal CLI profile under operate authority. */
  openProviderTerminal(owner: string, instanceId: string, action: "login" | "logout"): string {
    if (this.closed || this.terminals.size >= 8) throw new Error("Auth terminal unavailable");
    const instance = this.account(instanceId);
    if (
      instance.provider === "acp" ||
      instance.provider === "cursor" ||
      (!instance.implicit && !instance.managed)
    )
      throw new Error("Unsupported auth terminal");
    const release = this.options.accounts.reserveAccountChange(instance.id);
    const terminalId = this.options.id();
    this.terminals.set(terminalId, {
      owner,
      instance,
      action,
      scope: "operate",
      controller: new AbortController(),
      release,
    });
    const timer = setTimeout(() => {
      void this.stop(terminalId, owner).catch(() => {});
    }, 600_000);
    timer.unref();
    const entry = this.terminals.get(terminalId);
    if (entry) entry.cancelTimer = () => clearTimeout(timer);
    return terminalId;
  }
  /** A protocol-advertised login invocation: live, owner-scoped, never recorded. */
  openLoginTerminal(owner: string, launch: OpenTerminalOptions) {
    if (this.closed || this.terminals.size >= 8) throw new Error("Auth terminal unavailable");
    const terminalId = this.options.id();
    const { promise: exited, resolve: complete } = Promise.withResolvers<boolean>();
    this.terminals.set(terminalId, {
      owner,
      launch,
      action: "login",
      scope: "operate",
      controller: new AbortController(),
      complete,
      release: () => complete(false),
    });
    return { id: terminalId, exited, stop: () => this.stop(terminalId, owner) };
  }
  terminalScope(id: string): "accounts" | "operate" {
    return this.terminals.get(id)?.scope ?? "accounts";
  }
  owns(id: string, owner: string): boolean {
    return this.terminals.get(id)?.owner === owner;
  }
  subscribe(id: string, owner: string, emit: (event: TerminalEvent) => void): Promise<void> {
    const entry = this.terminals.get(id);
    if (!entry || entry.owner !== owner || entry.terminal || entry.starting)
      throw new Error("Auth terminal unavailable");
    entry.starting = true;
    // Install ownership before the first await so disconnect can abort and drain startup.
    entry.startup = Promise.resolve().then(() => this.start(id, entry, emit));
    return entry.startup;
  }
  private async start(
    id: string,
    entry: AuthTerminal,
    emit: (event: TerminalEvent) => void,
  ): Promise<void> {
    const signal = this.options.signal
      ? AbortSignal.any([entry.controller.signal, this.options.signal])
      : entry.controller.signal;
    signal.throwIfAborted();
    if (entry.launch) {
      const terminal = this.manager.openLiveTerminal(entry.launch, emit);
      entry.terminal = terminal;
      entry.starting = false;
      entry.done = terminal.exited.then(
        async (exit) => {
          await this.manager.releaseLive(terminal);
          entry.complete?.(exit.code === 0 && exit.signal === null && !signal.aborted);
          entry.release();
          this.terminals.delete(id);
        },
        () => {
          entry.release();
          this.terminals.delete(id);
        },
      );
      return;
    }
    const { instance, action } = entry;
    if (!instance) throw new Error("Account unavailable");
    if (!instance.implicit) await assertManagedHome(this.options.dataDir, instance);
    const sdk = instance.provider === "cursor" ? this.options.cursor?.() : undefined;
    if (instance.provider === "cursor" && !sdk) throw new Error("Cursor SDK is unavailable");
    entry.sdk = !!sdk;
    const env = instanceEnv(instance, sdk?.env ?? this.options.env, sdk ? "cursor-sdk" : undefined);
    const status = sdk
      ? { path: process.execPath, error: undefined }
      : await loginStatus(instance, {
          ...this.options.discovery,
          env,
          signal,
        });
    if (sdk) await sdk.fence(instance.id);
    if (!instance.implicit) await assertManagedHome(this.options.dataDir, instance);
    signal.throwIfAborted();
    if (!status.path || (instance.provider === "cursor" && !instance.implicit && status.error))
      throw new Error("Provider unavailable or isolation unverified");
    const args = sdk
      ? [
          fileURLToPath(new URL("./cursor-account-terminal.ts", import.meta.url)),
          instance.id,
          instance.homeDir,
          action,
        ]
      : action === "logout" && instance.provider !== "acp"
        ? logoutArgs(instance.provider)
        : instance.provider === "codex"
          ? [action]
          : instance.provider === "claude" || instance.provider === "opencode"
            ? ["auth", action]
            : [];
    const terminal = this.manager.openLiveTerminal(
      {
        shell: status.path,
        args,
        cwd: instance.implicit ? this.options.dataDir : instance.homeDir,
        env,
        name: `${instance.provider} ${action}`,
        cols: 80,
        rows: 24,
      },
      (event) => {
        if (event.type === "exit") entry.exited = true;
        emit(event);
      },
    );
    entry.terminal = terminal;
    entry.starting = false;
    entry.done = terminal.exited
      .catch(() => {})
      .then(async () => {
        await this.manager.releaseLive(terminal);
        try {
          this.options.registry.loginChanged(instance.id);
          if (sdk) await sdk.rebind(instance.id);
          await this.refresh(instance);
          if (this.options.registry.isPending(instance.id)) {
            if (
              !entry.controller.signal.aborted &&
              this.options.registry.get(instance.id)?.quota.auth === "logged_in"
            )
              this.options.registry.publishAccount(instance.id);
            else await this.discardPending(instance.id);
          }
          await this.options.authChanged?.();
        } finally {
          entry.cancelTimer?.();
          entry.release();
          this.terminals.delete(id);
        }
      });
    // Probe failures never include raw provider output in logs or stored errors.
    void entry.done.catch(() => {});
  }
  write(id: string, owner: string, data: string): void {
    this.live(id, owner).write(data);
  }
  resize(id: string, owner: string, cols: number, rows: number): void {
    this.live(id, owner).resize(cols, rows);
  }
  private live(id: string, owner: string): LiveTerminal {
    const entry = this.terminals.get(id);
    if (!entry || entry.owner !== owner || !entry.terminal || entry.starting)
      throw new Error("Auth terminal unavailable");
    return entry.terminal;
  }
  async stop(id: string, owner: string): Promise<void> {
    const entry = this.terminals.get(id);
    if (!entry || entry.owner !== owner) return;
    entry.cancelTimer?.();
    if (!entry.exited) entry.controller.abort(new Error("Auth terminal cancelled"));
    // Discovery/fencing owns resources until its promise settles, even on cancellation.
    await entry.startup?.catch(() => {});
    if (entry.terminal) {
      await this.manager.releaseLive(entry.terminal);
      await entry.done;
    } else {
      this.terminals.delete(id);
      entry.release();
    }
  }
  async disconnect(owner: string): Promise<void> {
    await Promise.all(
      [...this.terminals]
        .filter(([, entry]) => entry.owner === owner)
        .map(([id]) => this.stop(id, owner)),
    );
  }
  private async refresh(instance: ProviderInstance): Promise<void> {
    if (!instance.implicit) await assertManagedHome(this.options.dataDir, instance);
    if (instance.provider === "acp") return;
    const { registry, models, now } = this.options;
    const sdk = instance.provider === "cursor" ? this.options.cursor?.() : undefined;
    if (instance.provider === "cursor" && !sdk) return;
    const env = instanceEnv(instance, sdk?.env ?? this.options.env, sdk ? "cursor-sdk" : undefined);
    const status = sdk
      ? { auth: await sdk.status(instance), path: "" }
      : await loginStatus(instance, {
          ...this.options.discovery,
          env,
          ...(this.options.signal ? { signal: this.options.signal } : {}),
        });
    if (status.auth === "logged_in" && "authDetail" in status)
      registry.recordAuth(
        instance.id,
        reportedAuthMethod(status.authDetail),
        "accountLabel" in status ? status.accountLabel : undefined,
      );
    registry.ingest(instance.id, {
      provider: instance.provider,
      payload: new ProviderPayload(
        JSON.stringify({
          auth: status.auth,
          ...("authDetail" in status ? { authDetail: status.authDetail } : {}),
        }),
      ),
      observedAt: now(),
      timeZone: "UTC",
    });
    const catalog = models();
    if (!catalog) return;
    if (status.auth === "logged_out") {
      await catalog.removeInstance(instance.id);
      return;
    }
    this.registerCatalog(
      instance,
      sdk !== undefined,
      status.path ?? defaultProviderExecutable(instance.provider),
      env,
    );
    await catalog.refresh({ instance: instance.id });
  }
  private registerCatalog(
    instance: ProviderInstance,
    sdk: boolean,
    executable: string,
    env: NodeJS.ProcessEnv,
  ): void {
    const catalog = this.options.models();
    if (!catalog) return;
    catalog.registerInstance(
      {
        id: instance.id,
        label: instance.label,
        provider: instance.provider,
        ...(sdk ? { backend: "cursor-sdk", homeDir: instance.homeDir } : {}),
        executable,
        cwd: instance.implicit ? this.options.dataDir : instance.homeDir,
        env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value ?? ""])),
        loginRevision: this.options.registry.get(instance.id)?.instance.loginRevision ?? "0",
      },
      instance.implicit ? undefined : () => assertManagedHome(this.options.dataDir, instance),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.terminals].map(([id, entry]) => this.stop(id, entry.owner)));
    await Promise.allSettled(this.restorations);
    await this.manager.closeAll();
  }
}
