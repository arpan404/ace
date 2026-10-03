import {
  createPiAdapter,
  piProfile,
  piHistoryErrorMessage,
  type PiOptions,
  type PiSession,
} from "@ace/adapter-pi";
import { discoverPi, type DiscoveryResult } from "@ace/provider-kit/discovery";
import { AgentId, PiControlRequest, type PiControlResult, type ThreadId } from "@ace/protocol";
import type { AdapterRegistry } from "../engine/registry.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export interface PiService {
  register(registry: AdapterRegistry, cli: DiscoveryResult): void;
  handle(request: PiControlRequest): Promise<PiControlResult>;
}
export async function startPi(context: ServiceContext): Promise<void> {
  const sessions = new Map<ThreadId, PiSession>();
  const openingThreads = new Set<ThreadId>();
  let cli: DiscoveryResult | undefined;
  const service: PiService = {
    register(registry, source) {
      cli = source;
      if (!piProfile(source).supported) return;
      const adapter = createPiAdapter({
        ...context.options.pi,
        cli: source,
        openMcp(ctx, lifetime) {
          const mcp = context.services.mcp;
          const root = context.store.getThread(ctx.threadId)?.rootAgentId;
          if (!mcp || !root) throw new Error("Pi MCP caller unavailable");
          const lease = mcp.openSession(
            {
              threadId: ctx.threadId,
              agentId: AgentId.parse(root),
              sessionId: context.id(),
              capabilities: ["agents", "notify"],
            },
            lifetime,
          );
          return { url: mcp.url, bearer: lease.bearer, end: lease.end };
        },
      });
      registry.register(
        {
          ...adapter,
          async openSession(ctx) {
            if (
              sessions.size + openingThreads.size >= 128 ||
              sessions.has(ctx.threadId) ||
              openingThreads.has(ctx.threadId)
            )
              throw new Error("Pi session capacity exceeded");
            // Reserve admission before awaiting process startup.
            openingThreads.add(ctx.threadId);
            let opening = true;
            try {
              const session = await adapter.openSession({
                ...ctx,
                onExit(exit) {
                  opening = false;
                  sessions.delete(ctx.threadId);
                  ctx.onExit(exit);
                },
              });
              if (!opening) {
                await session.close("shutdown");
                throw new Error("Pi exited while opening");
              }
              const wrapped: PiSession = {
                ...session,
                close: async (reason) => {
                  try {
                    await session.close(reason);
                  } finally {
                    sessions.delete(ctx.threadId);
                  }
                },
              };
              sessions.set(ctx.threadId, wrapped);
              return wrapped;
            } finally {
              openingThreads.delete(ctx.threadId);
            }
          },
        },
        source,
      );
    },
    async handle(request) {
      const result = (value: PiControlResult["result"]): PiControlResult => ({
        type: "pi.result",
        requestId: request.requestId,
        result: value,
      });
      const thread = context.store.getThread(request.threadId);
      if (!thread || thread.provider !== "pi")
        return result({ ok: false, error: "Unknown Pi thread" });
      if (request.operation.kind === "profile")
        return result({
          ok: true,
          profile: piProfile(cli ?? { installed: false, auth: "unknown", loginHint: "pi /login" }),
        });
      if (!["done", "failed"].includes(thread.status.state))
        return result({ ok: false, error: "Pi history controls require a settled whole tree" });
      const session = sessions.get(request.threadId);
      if (!session)
        return result({
          ok: false,
          error: "Pi session is closed; resume the thread before using native history controls",
        });
      try {
        if (request.operation.kind === "fork")
          return result({ ok: true, ...(await session.fork(request.operation.entryId)) });
        await session.rollback(request.operation.entryId);
        return result({ ok: true });
      } catch (error) {
        return result({
          ok: false,
          error: piHistoryErrorMessage(error),
        });
      }
    },
  };
  context.services.pi = service;
  context.resources.own(async () => {
    await Promise.allSettled([...sessions.values()].map((session) => session.close("shutdown")));
    sessions.clear();
  });
}
/** Metadata-only discovery; this registration never starts a Pi session. */
export async function registerPi(
  context: ServiceContext,
  registry: AdapterRegistry,
): Promise<void> {
  const discover = context.options.pi?.runtime?.discover ?? discoverPi;
  const cli = await discover(
    context.options.pi?.executable ? { executable: context.options.pi.executable } : {},
  );
  context.services.pi?.register(registry, cli);
}
export function createPiSocketSession(context: SocketContext): SocketService {
  let pending = 0;
  const receipts = new Map<
    string,
    { fingerprint: string; promise: Promise<PiControlResult>; settled: boolean }
  >();
  const deliver = (task: Promise<PiControlResult>, requestId: string) => {
    pending++;
    const delivery: Promise<void> = task
      .then(
        (response) => {
          if (context.connected()) context.send(response);
        },
        () => {
          if (context.connected())
            context.send({
              type: "pi.result",
              requestId,
              result: { ok: false, error: "Pi native history operation failed" },
            });
        },
      )
      .catch(() => context.socket.terminate())
      .finally(() => {
        pending--;
        context.tasks.delete(delivery);
      });
    context.tasks.add(delivery);
  };
  return {
    handle(input) {
      const parsed = PiControlRequest.safeParse(input);
      if (!parsed.success) return false;
      const request = parsed.data;
      const fail = (error: string) =>
        context.send({
          type: "pi.result",
          requestId: request.requestId,
          result: { ok: false, error },
        });
      const scope = request.operation.kind === "profile" ? "read" : "operate";
      if (!context.authorize(scope) || !context.canReadThread(request.threadId)) {
        fail(`${scope} scope and thread access required`);
        return true;
      }
      const service = context.options.pi;
      if (!service) {
        fail("Pi service unavailable");
        return true;
      }
      const fingerprint = JSON.stringify(request);
      const existing = receipts.get(request.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          fail("Pi request id reused for different content");
          return true;
        }
        if (pending >= 8) {
          fail("Pi request capacity exceeded");
          return true;
        }
        deliver(existing.promise, request.requestId);
        return true;
      }
      if (pending >= 8) {
        fail("Pi request capacity exceeded");
        return true;
      }
      if (receipts.size >= 128) {
        for (const [id, entry] of receipts)
          if (entry.settled) {
            receipts.delete(id);
            break;
          }
      }
      const task = Promise.resolve().then(() => service.handle(request));
      const receipt = { fingerprint, promise: task, settled: false };
      receipts.set(request.requestId, receipt);
      void task.then(
        () => {
          receipt.settled = true;
        },
        () => {
          receipt.settled = true;
        },
      );
      deliver(task, request.requestId);
      return true;
    },
  };
}
export type PiDaemonOptions = Omit<PiOptions, "openMcp" | "cli">;
