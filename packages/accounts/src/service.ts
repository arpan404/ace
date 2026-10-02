import { AccountsRequest, AccountsResponse, AccountProvider } from "@ace/protocol/accounts";
import type { ProviderAdapter, ProviderSession, SessionContext } from "@ace/engine-api";
import type { AccountRegistry } from "./registry.ts";
import { object } from "./quota-decode.ts";
import { instanceEnv } from "./instances.ts";
import { pickInstance } from "./scheduler.ts";
import { migrateSession, type MigrationSafety } from "./migration.ts";
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
  private writers = new Map<string, number>();
  private migrating = new Set<string>();
  constructor(options: {
    registry: AccountRegistry;
    now: () => number;
    timeZone: string;
    env: NodeJS.ProcessEnv;
    safety?: MigrationSafety;
  }) {
    this.registry = options.registry;
    this.now = options.now;
    this.timeZone = options.timeZone;
    this.env = options.env;
    this.safety = options.safety ?? { acquire: async () => undefined };
  }
  async handle(input: unknown): Promise<AccountsResponse> {
    const request = AccountsRequest.parse(input);
    if (request.type === "accounts.list")
      return AccountsResponse.parse({ ...request, accounts: this.registry.summaries(this.now()) });
    if (request.type === "accounts.status")
      return AccountsResponse.parse({
        type: request.type,
        requestId: request.requestId,
        account:
          this.registry.summaries(this.now()).find((a) => a.id === request.instanceId) ?? null,
      });
    const from = this.registry.get(request.from)?.instance;
    const to = this.registry.get(request.to)?.instance;
    const refused = (reason: string): AccountsResponse => ({
      type: request.type,
      requestId: request.requestId,
      result: { status: "refused", reason },
    });
    if (!from || !to) return refused("Unknown instance");
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
    assignment: { instanceId?: string; role: string; estimatedLoad: number },
  ): Promise<{ instanceId: string; session: ProviderSession }> {
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
    if (!chosen || chosen.provider !== adapter.provider)
      throw new Error("No matching provider instance");
    if (this.migrating.has(chosen.id)) throw new Error("Instance is migrating");
    this.writers.set(chosen.id, (this.writers.get(chosen.id) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const count = (this.writers.get(chosen.id) ?? 1) - 1;
      if (count) this.writers.set(chosen.id, count);
      else this.writers.delete(chosen.id);
    };
    try {
      const session = await adapter.openSession({
        ...context,
        env: instanceEnv(chosen, this.env),
        onFrame: (frame) => {
          const envelope = object(frame.data);
          const body = object(envelope["params"] ?? envelope);
          if (quotaKeys.some((key) => Object.hasOwn(body, key)))
            this.registry.ingest(chosen.id, {
              provider: chosen.provider,
              payload: frame.data,
              observedAt: this.now(),
              timeZone: this.timeZone,
            });
          context.onFrame(frame);
        },
        onExit: (exit) => {
          release();
          context.onExit(exit);
        },
      });
      return {
        instanceId: chosen.id,
        session: {
          nativeSessionId: session.nativeSessionId,
          send: (input, delivery) => session.send(input, delivery),
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
      release();
      throw error;
    }
  }
}
