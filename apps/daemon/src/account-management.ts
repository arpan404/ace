import { fileURLToPath } from "node:url";
import {
  AccountManagementRequest,
  type AccountsResponse,
  type ProviderInstance,
} from "@ace/protocol/accounts";
import type { TerminalEvent } from "@ace/terminal";
import {
  createPosixBackendFactory,
  TerminalManager,
  type LiveTerminal,
  type TerminalManagerOptions,
} from "@ace/terminal";
import { instanceEnv, loginStatus, type AccountRegistry, type AccountService } from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { DiscoveryOptions } from "@ace/provider-kit/discovery";
import {
  assertManagedHome,
  createManagedHome,
  deleteManagedHome,
  registerImplicitAccounts,
} from "./account-homes.ts";
import type { ModelCatalog } from "@ace/models";

interface AuthTerminal {
  starting?: boolean;
  sdk?: boolean;
  owner: string;
  instance: ProviderInstance;
  action: "login" | "logout";
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
  signal?: AbortSignal | undefined;
  discovery?: DiscoveryOptions | undefined;
  terminal?: TerminalManagerOptions | undefined;
}

/** Host-local account changes. Provider auth output has no persistence or replay path. */
export class AccountManagement {
  private options: AccountManagementOptions;
  private manager: TerminalManager;
  private terminals = new Map<string, AuthTerminal>();
  private closed = false;
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
    await registerImplicitAccounts(this.options.registry, this.options.env);
    // Restore isolated catalog identities on restart, using only read-only metadata probes.
    for (const { instance } of this.options.registry.list())
      if (instance.managed) {
        this.options.signal?.throwIfAborted();
        await this.refresh(instance);
      }
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
        await registry.register(instance);
      } catch (error) {
        await deleteManagedHome(this.options.dataDir, instance);
        throw error;
      }
      return changed(id);
    }
    if (request.type === "accounts.setDefault") {
      if (this.account(request.instanceId).provider !== request.provider)
        throw new Error("Provider mismatch");
      registry.selectProvider(request.provider, request.instanceId);
      return changed(request.instanceId);
    }
    const instance = this.editable(request.instanceId);
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
      if (request.type === "accounts.rename") registry.rename(instance.id, request.label);
      else {
        if (instance.provider === "cursor") await this.options.cursor?.()?.fence(instance.id);
        // Catalog cancellation completes before a private home can be removed.
        await this.options.models()?.removeInstance(instance.id);
        if (request.deleteHome) await deleteManagedHome(this.options.dataDir, instance);
        registry.unregister(instance.id);
        return changed();
      }
      return changed(instance.id);
    } finally {
      release();
    }
  }
  owns(id: string, owner: string): boolean {
    return this.terminals.get(id)?.owner === owner;
  }
  async subscribe(id: string, owner: string, emit: (event: TerminalEvent) => void): Promise<void> {
    const entry = this.terminals.get(id);
    if (!entry || entry.owner !== owner || entry.terminal || entry.starting)
      throw new Error("Auth terminal unavailable");
    entry.starting = true;
    const { instance, action } = entry;
    await assertManagedHome(this.options.dataDir, instance);
    const sdk = instance.provider === "cursor" ? this.options.cursor?.() : undefined;
    entry.sdk = !!sdk;
    const env = instanceEnv(instance, sdk?.env ?? this.options.env, sdk ? "cursor-sdk" : undefined);
    const status = sdk
      ? { path: process.execPath, error: undefined }
      : await loginStatus(instance, {
          ...this.options.discovery,
          env,
          ...(this.options.signal ? { signal: this.options.signal } : {}),
        });
    if (sdk) await sdk.fence(instance.id);
    if (this.closed || this.terminals.get(id) !== entry) throw new Error("Auth terminal cancelled");
    if (!status.path || (instance.provider === "cursor" && status.error))
      throw new Error("Provider unavailable or isolation unverified");
    const args = sdk
      ? [
          fileURLToPath(new URL("./cursor-account-terminal.ts", import.meta.url)),
          instance.id,
          instance.homeDir,
          action,
        ]
      : instance.provider === "codex" || instance.provider === "cursor"
        ? [action]
        : instance.provider === "claude" || instance.provider === "opencode"
          ? ["auth", action]
          : [];
    const terminal = this.manager.openLiveTerminal(
      {
        shell: status.path,
        args,
        cwd: instance.homeDir,
        env,
        name: `${instance.provider} ${action}`,
        cols: 80,
        rows: 24,
      },
      emit,
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
        } finally {
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
    const { registry, models, now } = this.options;
    const sdk = instance.provider === "cursor" ? this.options.cursor?.() : undefined;
    const env = instanceEnv(instance, sdk?.env ?? this.options.env, sdk ? "cursor-sdk" : undefined);
    const status = sdk
      ? { auth: await sdk.status(instance), path: "" }
      : await loginStatus(instance, {
          ...this.options.discovery,
          env,
          ...(this.options.signal ? { signal: this.options.signal } : {}),
        });
    registry.ingest(instance.id, {
      provider: instance.provider,
      payload: new ProviderPayload(JSON.stringify({ auth: status.auth })),
      observedAt: now(),
      timeZone: "UTC",
    });
    const catalog = models();
    if (!catalog) return;
    await catalog.removeInstance(instance.id);
    if ((!status.path && !sdk) || status.auth === "logged_out") return;
    if (sdk) {
      catalog.registerInstance({
        id: instance.id,
        provider: "cursor",
        backend: "cursor-sdk",
        homeDir: instance.homeDir,
        cwd: instance.homeDir,
        loginRevision: registry.get(instance.id)?.instance.loginRevision ?? "0",
      });
      await catalog.refresh({ instance: instance.id });
      return;
    }
    // Undefined masks are represented as empty values at the catalog boundary, not omitted.
    const modelEnv = Object.fromEntries(
      Object.entries(env).map(([key, value]) => [key, value ?? ""]),
    );
    catalog.registerInstance({
      id: instance.id,
      provider: instance.provider,
      executable: status.path,
      cwd: instance.homeDir,
      env: modelEnv,
      loginRevision: registry.get(instance.id)?.instance.loginRevision ?? "0",
    });
    await catalog.refresh({ instance: instance.id });
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.terminals].map(([id, entry]) => this.stop(id, entry.owner)));
    await this.manager.closeAll();
  }
}
