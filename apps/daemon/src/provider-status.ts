import { providerReadiness, onboardingChecklist } from "@ace/core";
import { providerStatusRow } from "./provider-status-row.ts";
import { type ProviderStatus as Status } from "@ace/protocol";
import {
  discoverProvider,
  discoverPiStatus,
  discoverAntigravity,
  type DiscoveryOptions,
  type DiscoveryResult,
} from "@ace/provider-kit/discovery";
import { assertTestEnvironmentIsolation } from "@ace/provider-kit/test-isolation";

export interface ProviderStatusOptions extends DiscoveryOptions {
  piExecutable?: string;
  configuration?: (provider: Status["provider"]) => {
    enabled?: boolean | undefined;
    binaryPath?: string | undefined;
  };
  attention?(row: Status): boolean;
  checked?(rows: readonly Status[]): void;
  cursorSdk?(signal: AbortSignal): Promise<DiscoveryResult>;
}
export interface ProviderStatusRuntime {
  now(): number;
  schedule(expire: () => void, ms: number): () => void;
}
const providers = ["claude", "codex", "opencode", "cursor", "pi", "antigravity"] as const;
/** Bounded metadata only, in memory. Startup and cached reads never wait for probes. */
export class ProviderStatuses {
  private rows: Status[] = providers.map((provider) => ({
    provider,
    runtime: provider === "cursor" ? "cursor-sdk" : "cli",
    installed: null,
    auth: "unknown",
    loginHint: "",
    stale: true,
    refreshing: false,
  }));
  private listeners = new Set<(rows: Status[]) => void>();
  listen(listener: (rows: Status[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publish(): void {
    for (const listener of this.listeners) listener(this.readiness());
  }
  private options: ProviderStatusOptions;
  private runtime: ProviderStatusRuntime;
  private controller = new AbortController();
  private flight: Promise<void> | undefined;
  private cancelTimer?: () => void;
  constructor(options: ProviderStatusOptions, runtime: ProviderStatusRuntime) {
    assertTestEnvironmentIsolation({ ...process.env, ...options.env });
    this.options = options;
    this.runtime = runtime;
    void this.refresh();
  }
  list(): Status[] {
    const now = this.runtime.now();
    return this.rows.map((row) =>
      providerReadiness({
        ...row,
        ...(this.options.attention?.(row) ? { readiness: "needs_attention" as const } : {}),
        enabled: this.options.configuration?.(row.provider).enabled !== false,
        stale: row.checkedAt === undefined || now - row.checkedAt >= 300_000,
        refreshing: Boolean(this.flight),
      }),
    );
  }
  readiness(): Status[] {
    return onboardingChecklist(this.list()).providers;
  }
  refresh(): Promise<void> {
    if (this.flight) return this.flight;
    if (this.controller.signal.aborted) return Promise.resolve();
    this.cancelTimer?.();
    const options = {
      ...this.options,
      signal: this.controller.signal,
      timeoutMs: this.options.timeoutMs ?? 4000,
    };
    const probe = (row: Status): Promise<DiscoveryResult | undefined> => {
      const configuration = this.options.configuration?.(row.provider);
      if (configuration?.enabled === false) return Promise.resolve(undefined);
      const configured = {
        ...options,
        ...(configuration?.binaryPath &&
        ["claude", "codex", "opencode", "cursor"].includes(row.provider)
          ? { overrides: { ...options.overrides, [row.provider]: configuration.binaryPath } }
          : {}),
      };
      if (row.runtime === "cursor-sdk")
        return this.options.cursorSdk?.(this.controller.signal) ?? Promise.resolve(undefined);
      switch (row.provider) {
        case "pi": {
          const executable = configuration?.binaryPath ?? this.options.piExecutable;
          return discoverPiStatus({ ...options, ...(executable ? { executable } : {}) });
        }
        case "antigravity":
          return discoverAntigravity({
            ...options,
            ...(configuration?.binaryPath ? { executable: configuration.binaryPath } : {}),
          });
        case "claude":
        case "codex":
        case "opencode":
          return discoverProvider(row.provider, configured);
        case "cursor":
        case "acp":
          return Promise.resolve(undefined);
      }
    };
    const work = this.rows.map(async (row): Promise<Status> => {
      try {
        const status = await probe(row);
        return providerStatusRow(row, status, this.runtime.now());
      } catch {
        return {
          provider: row.provider,
          runtime: row.runtime,
          installed: null,
          auth: "unknown",
          loginHint: row.loginHint,
          error: "Provider discovery failed",
          checkedAt: this.runtime.now(),
          stale: false,
          refreshing: false,
        };
      }
    });
    this.flight = Promise.all(work)
      .then((rows) => {
        if (!this.controller.signal.aborted) {
          this.rows = rows;
          this.options.checked?.(rows);
        }
      })
      .finally(() => {
        this.flight = undefined;
        if (!this.controller.signal.aborted)
          this.cancelTimer = this.runtime.schedule(() => {
            void this.refresh();
          }, 300_000);
      });
    return this.flight;
  }
  async close(): Promise<void> {
    this.controller.abort();
    this.cancelTimer?.();
    await this.flight;
    this.listeners.clear();
  }
}
