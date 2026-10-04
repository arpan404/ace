import {
  AccountsRequest,
  AccountsResponse,
  AccountProvider,
  AccountAssignment,
} from "@ace/protocol/accounts";
import type { ProviderAdapter, ProviderSession, SessionContext } from "@ace/engine-api";
import type { AccountRegistry } from "./registry.ts";
import { object } from "./quota-decode.ts";
import { loginAcpAccount, type AcpLoginResolver } from "./acp-login.ts";
import { AcpIdentity } from "@ace/protocol";
import { instanceEnv } from "./instances.ts";
import { pickInstance } from "./scheduler.ts";
import { migrateSession, type MigrationSafety } from "./migration.ts";
import { accountFrame } from "./frames.ts";
export type AccountAdapterFactory = Pick<
  ProviderAdapter,
  "provider" | "capabilities" | "createTranslator" | "backend"
> & {
  /** Called after assignment, so native adapters using constructor env also select this account. */
  create(
    env: NodeJS.ProcessEnv,
    context: SessionContext,
  ): Pick<ProviderAdapter, "openSession"> | Promise<Pick<ProviderAdapter, "openSession">>;
};
const quotaKeys = [
  "rateLimits",
  "rateLimitsByLimitId",
  "rate_limit_info",
  "rate_limits",
  "auth",
  "tokenUsage",
  "usage",
  "session",
  "total_cost_usd",
  "message",
  "error",
];
/** The default never infers offline safety from absence of locks or ace processes. */
export class AccountService {
  private registry: AccountRegistry;
  private now: () => number;
  private timeZone: string;
  private safety: MigrationSafety;
  private env: NodeJS.ProcessEnv;
  private cursorEnv: NodeJS.ProcessEnv;
  private resolveAcpLogin: AcpLoginResolver | undefined;
  private writers = new Map<string, number>();
  private migrating = new Set<string>();
  constructor(options: {
    registry: AccountRegistry;
    now: () => number;
    timeZone: string;
    env: NodeJS.ProcessEnv;
    cursorEnv?: NodeJS.ProcessEnv;
    safety?: MigrationSafety;
    resolveAcpLogin?: AcpLoginResolver;
  }) {
    this.registry = options.registry;
    this.now = options.now;
    this.timeZone = options.timeZone;
    this.env = options.env;
    this.cursorEnv = options.cursorEnv ?? options.env;
    this.resolveAcpLogin = options.resolveAcpLogin;
    this.safety = options.safety ?? { acquire: async () => undefined };
  }
  isChangingAccount(id: string): boolean {
    return this.migrating.has(id);
  }
  reserveAccountChange(id: string): () => void {
    if (this.writers.has(id) || this.migrating.has(id)) throw new Error("Instance is busy");
    this.migrating.add(id);
    return () => this.migrating.delete(id);
  }
  /** Local interactive terminal API, deliberately absent from remote accounts messages. */
  async loginAcp(instanceId: string, signal?: AbortSignal) {
    const instance = this.registry.get(instanceId)?.instance;
    if (!instance || instance.provider !== "acp") throw new Error("Unknown ACP instance");
    if (this.writers.has(instanceId) || this.migrating.has(instanceId))
      throw new Error("Instance is busy");
    this.migrating.add(instanceId);
    try {
      return await loginAcpAccount(this.registry, instance, {
        env: this.env,
        resolve: this.resolveAcpLogin ?? (async () => undefined),
        ...(signal ? { signal } : {}),
      });
    } finally {
      this.migrating.delete(instanceId);
    }
  }
  /** Daemon-local environment and login generation, resolved by immutable identity. */
  acpEnvironment(input: AcpIdentity): { env: NodeJS.ProcessEnv; loginRevision: string } {
    const identity = AcpIdentity.parse(input);
    const chosen = this.registry.get(identity.instanceId)?.instance;
    if (
      !chosen ||
      chosen.provider !== "acp" ||
      chosen.acpAgentId !== identity.acpAgentId ||
      chosen.installationId !== identity.installationId
    )
      throw new Error("No matching ACP account identity");
    return { env: instanceEnv(chosen, this.env), loginRevision: chosen.loginRevision ?? "0" };
  }
  preferredCursorInstance(): string | undefined {
    return (
      this.registry.selectedProvider("cursor") ??
      this.registry.selectedCursorSdk() ??
      pickInstance(
        { provider: "cursor", role: "worker", estimatedLoad: 1 },
        this.registry.list().filter((a) => !this.migrating.has(a.instance.id)),
        this.now(),
      )?.id
    );
  }
  /** Register this adapter with the engine instead of the unbound native adapter. */
  bindAdapter(
    factory: AccountAdapterFactory,
    assignmentFor: (context: SessionContext) => AccountAssignment = (context) => ({
      ...(context.instanceId === undefined && !context.acpIdentity
        ? {}
        : { instanceId: context.instanceId ?? context.acpIdentity?.instanceId }),
      role: "worker",
      estimatedLoad: 1,
    }),
  ): ProviderAdapter {
    AccountProvider.parse(factory.provider);
    const adapter: ProviderAdapter = {
      provider: factory.provider,
      ...(factory.backend ? { backend: factory.backend } : {}),
      capabilities: (cli) => factory.capabilities(cli),
      createTranslator: (init) => factory.createTranslator(init),
      openSession: async (context) =>
        (await factory.create(context.env ?? {}, context)).openSession(context),
    };
    return {
      ...adapter,
      openSession: async (context) =>
        (await this.openSession(adapter, context, assignmentFor(context))).session,
    };
  }
  async handle(input: unknown): Promise<AccountsResponse> {
    const request = AccountsRequest.parse(input);
    if (request.type === "accounts.list")
      return AccountsResponse.parse({ ...request, accounts: this.registry.summaries(this.now()) });
    if (request.type === "accounts.status")
      return AccountsResponse.parse({
        type: request.type,
        requestId: request.requestId,
        account: this.registry.summary(request.instanceId, this.now()) ?? null,
      });
    if (request.type !== "accounts.migrate")
      throw new Error("Use the daemon account management service");
    const from = this.registry.get(request.from)?.instance;
    const to = this.registry.get(request.to)?.instance;
    const refused = (reason: string): AccountsResponse => ({
      type: request.type,
      requestId: request.requestId,
      result: { status: "refused", reason },
    });
    if (!from || !to) return refused("Unknown instance");
    if (from.implicit || to.implicit) return refused("Normal CLI homes are immutable");
    for (const id of [from.id, to.id])
      if (this.writers.has(id) || this.migrating.has(id))
        return refused("Source or destination has an active writer or migration");
    this.migrating.add(from.id);
    this.migrating.add(to.id);
    let releaseFailed = false;
    try {
      const result = await migrateSession(
        { provider: request.provider, nativeSessionId: request.nativeSessionId, from, to },
        this.safety,
      );
      releaseFailed = result.cleanupWarnings?.includes("lease_release_failed") ?? false;
      return AccountsResponse.parse({ type: request.type, requestId: request.requestId, result });
    } finally {
      if (!releaseFailed) {
        this.migrating.delete(from.id);
        this.migrating.delete(to.id);
      }
    }
  }
  /** Bind adapter environment and quota frames to the selected instance, never a global login. */
  async openSession(
    adapter: ProviderAdapter,
    context: SessionContext,
    selection: AccountAssignment,
  ): Promise<{ instanceId: string; session: ProviderSession }> {
    const preferred =
      adapter.backend === "cursor-sdk" && !context.resume
        ? this.registry.selectedCursorSdk()
        : undefined;
    if (context.resume && !selection.instanceId)
      throw new Error("Resuming requires a pinned provider instance");
    const assignment = AccountAssignment.parse({
      ...selection,
      instanceId:
        selection.instanceId ??
        this.registry.selectedProvider(adapter.provider) ??
        preferred ??
        (adapter.backend !== "cursor-sdk" &&
        this.registry.get(`${adapter.provider}-cli-default`)?.instance.implicit
          ? `${adapter.provider}-cli-default`
          : undefined),
    });
    if (context.resume && !assignment.instanceId)
      throw new Error("Resuming requires a pinned provider instance");
    const provider = AccountProvider.parse(adapter.provider);
    const chosen = assignment.instanceId
      ? this.registry.get(assignment.instanceId)?.instance
      : pickInstance(
          {
            provider,
            role: assignment.role,
            estimatedLoad: assignment.estimatedLoad,
          },
          this.registry.list().filter((a) => !this.migrating.has(a.instance.id)),
          this.now(),
        );
    if (provider === "acp") {
      const identity = AcpIdentity.parse(context.acpIdentity);
      if (
        !chosen ||
        chosen.acpAgentId !== identity.acpAgentId ||
        chosen.installationId !== identity.installationId ||
        chosen.id !== identity.instanceId
      )
        throw new Error("No matching ACP account identity");
    }
    if (!chosen || chosen.provider !== adapter.provider)
      throw new Error("No matching provider instance");
    if (chosen.implicit && adapter.backend === "cursor-sdk")
      throw new Error("The normal Cursor CLI login cannot authenticate the SDK backend");
    if (this.migrating.has(chosen.id)) throw new Error("Instance is migrating");
    this.writers.set(chosen.id, (this.writers.get(chosen.id) ?? 0) + 1);
    const lifetime = new AbortController();
    const abort = () => lifetime.abort(context.signal.reason);
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      context.signal.removeEventListener("abort", abort);
      lifetime.abort();
      const count = (this.writers.get(chosen.id) ?? 1) - 1;
      if (count) this.writers.set(chosen.id, count);
      else this.writers.delete(chosen.id);
    };
    let opened: ProviderSession | undefined;
    let frameFailed = false;
    let stopping: Promise<void> | undefined;
    const stopInvalidFrame = () => {
      if (!opened || stopping) return;
      stopping = opened.close("shutdown").then(
        () => {
          release();
          context.onExit({
            deliberate: false,
            message: "Provider frame has no valid bounded payload",
          });
        },
        () => {
          // A failed close cannot prove termination, so retain the writer reservation.
          context.onExit({
            deliberate: false,
            message: "Invalid provider frame; provider shutdown failed",
          });
        },
      );
    };
    try {
      const session = await adapter.openSession({
        ...context,
        instanceId: chosen.id,
        instanceHomeDir: chosen.homeDir,
        signal: lifetime.signal,
        env: instanceEnv(
          chosen,
          { ...(adapter.backend === "cursor-sdk" ? this.cursorEnv : this.env), ...context.env },
          adapter.backend,
        ),
        onFrame: (input) => {
          if (released || frameFailed) return;
          const frame = accountFrame(input);
          if (!frame) {
            frameFailed = true;
            lifetime.abort(new Error("Invalid provider frame"));
            stopInvalidFrame();
            return;
          }
          const envelope = object(frame.data);
          const body = object(envelope["params"] ?? envelope);
          if (quotaKeys.some((key) => Object.hasOwn(body, key)))
            this.registry.ingest(chosen.id, {
              provider: chosen.provider,
              payload: frame.payload,
              observedAt: this.now(),
              timeZone: this.timeZone,
            });
          return context.onFrame(frame);
        },
        onExit: (exit) => {
          if (frameFailed || released) return;
          release();
          context.onExit(exit);
        },
      });
      opened = session;
      if (frameFailed) {
        stopInvalidFrame();
        await stopping;
        throw new Error("Provider frame has no valid bounded payload");
      }
      return {
        instanceId: chosen.id,
        session: {
          instanceId: chosen.id,
          ...(session.backend ? { backend: session.backend } : {}),
          get effectiveCapabilities() {
            return session.effectiveCapabilities;
          },
          get acpSupport() {
            return session.acpSupport;
          },
          ...(session.setModel
            ? {
                setModel: (model: string) =>
                  session.setModel?.(model) ??
                  Promise.reject(new Error("Model selection unavailable")),
              }
            : {}),
          ...(session.setMode
            ? {
                setMode: (mode: string) =>
                  session.setMode?.(mode) ??
                  Promise.reject(new Error("Mode selection unavailable")),
              }
            : {}),
          ...(session.mcp ? { mcp: session.mcp } : {}),
          get nativeSessionId() {
            return session.nativeSessionId;
          },
          ...(session.configure
            ? {
                configure: (execution: import("@ace/protocol").ExecutionSelection) =>
                  session.configure?.(execution) ?? Promise.resolve(),
              }
            : {}),
          send: (input, delivery, intent) => session.send(input, delivery, intent),
          interrupt: (target) => session.interrupt(target),
          resolve: (interaction, resolution) => session.resolve(interaction, resolution),
          stopTask: (task) => session.stopTask(task),
          close: async (reason) => {
            await session.close(reason);
            release();
          },
        },
      };
    } catch (error) {
      if (!frameFailed) release();
      throw error;
    }
  }
}
