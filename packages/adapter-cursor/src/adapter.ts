import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDaemonHome } from "@ace/service/home";
import type { ProviderAdapter, SessionContext, ProviderSession } from "@ace/engine-api";
import type { AceMcpConnection } from "@ace/mcp-server";
import { cursorCapabilitiesForSandbox } from "./policy.ts";
import { cursorSdkEnvironment, CursorInstance, defaultCursorInstance } from "./instance.ts";
import { discoverCursorSdk, type HostOptions } from "./host.ts";
import { CursorTranslator } from "./translator.ts";
import type { readCursorSnapshot } from "./history.ts";
import { CursorHostSlots } from "./slots.ts";
import { Limits, type CursorLimits } from "./contracts.ts";
import { addShippedSkills, mirrorCursorUserConfig } from "./user-settings.ts";

export interface CursorAdapterOptions extends Omit<HostOptions, "env"> {
  instance?: CursorInstance;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  operationId?: () => string;
  policy?: "restricted" | "full-access";
  autoReviewAvailable?: boolean;
  /**
   * Per-session limit overrides, read live on every open (e.g. from provider
   * settings). Wins over `limits` when both set the same key; the translator
   * and host slots keep the adapter-wide `limits`.
   */
  limitsForSession?: (instanceId?: string) => Partial<CursorLimits> | undefined;
  /**
   * The person's real home, whose user-level `~/.cursor` config (never its credentials) is
   * copied into the private instance home before each session. Defaults to the daemon's home.
   */
  userHome?: string;
  /** The owner issues a thread/instance-scoped lease; no shared static token. */
  mcp?: (context: SessionContext & { instanceId: string }) => Promise<{
    connection: AceMcpConnection;
    /** This session's ace guidance for Cursor's always-applied rule, rendered once at open. */
    instructions?: string;
    signal?: AbortSignal;
    end(): void;
  }>;
}
export function createCursorAdapter(
  options: CursorAdapterOptions = {},
): ProviderAdapter & { close(): Promise<void>; stopInstance(id: string): Promise<void> } {
  const selected = CursorInstance.parse(
    options.instance ?? defaultCursorInstance(resolveDaemonHome(homedir(), process.env.ACE_HOME)),
  );
  const sessions = new Map<ProviderSession, string>();
  const limits = Limits.parse(options.limits ?? {});
  const slots = options.slots ?? new CursorHostSlots(limits.maxWorkers);
  let opening = 0;
  const admissions = new Map<Promise<void>, string>();
  let closed = false;
  const fenced = new Set<string>();
  // One copy at a time: concurrent opens would otherwise swap the same entries under each other.
  let mirroring: Promise<unknown> = Promise.resolve();
  const mirror = (home: string, skills: readonly string[]) => {
    const next = mirroring.then(async () => {
      await mirrorCursorUserConfig(options.userHome ?? homedir(), home);
      // ace's shipped skills join the person's own, which win on a shared name.
      await addShippedSkills(home, skills);
    });
    mirroring = next.catch(() => {});
    return next;
  };
  return {
    provider: "cursor",
    backend: "cursor-sdk",
    capabilities: () => cursorCapabilitiesForSandbox(options.autoReviewAvailable ?? false),
    createTranslator: (init) =>
      new CursorTranslator({
        ...init,
        maxIdentities: limits.maxIdentities,
        maxRetainedBytes: limits.maxPendingBytes,
      }),
    async openSession(context) {
      if (context.fork)
        throw new Error(
          "Cursor SDK does not support native forks; use a fresh ace portable context handoff",
        );
      if (
        context.resume &&
        (context.resume.backend !== "cursor-sdk" || context.resume.instanceId !== selected.id)
      )
        throw new Error("Cursor SDK resume requires its original backend and provider instance");
      const installation = await discoverCursorSdk(options.discovery);
      if (!installation.supported)
        throw new Error(installation.error ?? "Cursor SDK is not installed");
      if (context.instanceId && context.instanceId !== selected.id)
        throw new Error("Cursor instance selection does not match adapter binding");
      if (closed || fenced.has(selected.id))
        throw new Error("Cursor instance is signed out or shutting down");
      if (sessions.size + opening >= limits.maxWorkers)
        throw new Error("Cursor SDK host capacity reached");
      context.onSessionIdentity?.({ backend: "cursor-sdk", instanceId: selected.id });
      opening++;
      const { promise: admission, resolve: admissionDone } = Promise.withResolvers<void>();
      admissions.set(admission, selected.id);
      let lease: Awaited<ReturnType<NonNullable<CursorAdapterOptions["mcp"]>>> | undefined;
      try {
        if (context.env && context.env.HOME !== join(selected.homeDir, "user"))
          throw new Error("Cursor SDK host home must match the selected instance");
        const env = cursorSdkEnvironment(selected, context.env ?? options.env ?? process.env);
        // An accounts-composed environment must already carry the private SDK default home.
        if (env.HOME !== join(selected.homeDir, "user"))
          throw new Error("Cursor SDK host home must match the selected instance");
        await mirror(join(selected.homeDir, "user"), context.builtinSkills?.directories ?? []);
        lease = await options.mcp?.({ ...context, instanceId: selected.id });
        let session: ProviderSession | undefined;
        let exitedDuringAdmission = false;
        const {
          mcp: _mcpFactory,
          userHome: _userHome,
          limits: _baseLimits,
          limitsForSession: _limitsForSession,
          ...hostOptions
        } = options;
        // Session limits are resolved live so a settings change applies to the
        // next thread open without a daemon restart.
        const sessionLimits = Limits.parse({
          ...options.limits,
          ...options.limitsForSession?.(context.instanceId),
        });
        let recoverySnapshot: Awaited<ReturnType<typeof readCursorSnapshot>> | undefined;
        if (context.resume) {
          // Canonical ace history already owns content. Validate a bounded snapshot
          // without appending positional SDK messages as new live transcript entries.
          const { readCursorSnapshot } = await import("./history.ts");
          recoverySnapshot = await readCursorSnapshot(
            { ...hostOptions, slots, env, instanceId: selected.id, limits: sessionLimits },
            {
              threadId: context.threadId,
              agentId: context.resume.nativeSessionId,
              cwd: context.cwd,
            },
            context.signal,
          );
        }
        const { openCursorSession } = await import("./session.ts");
        const opened = await openCursorSession(
          {
            ...context,
            signal: lease?.signal
              ? AbortSignal.any([context.signal, lease.signal])
              : context.signal,
            onExit: (exit) => {
              exitedDuringAdmission = true;
              if (session) sessions.delete(session);
              lease?.end();
              context.onExit(exit);
            },
          },
          {
            ...hostOptions,
            slots,
            env,
            instanceId: selected.id,
            limits: sessionLimits,
            ...(recoverySnapshot ? { recoverySnapshot } : {}),
            ...(lease ? { mcp: lease.connection } : {}),
            ...(lease?.instructions ? { instructions: lease.instructions } : {}),
          },
        );
        session = {
          ...opened,
          close: async (reason) => {
            await opened.close(reason);
            if (session) sessions.delete(session);
            lease?.end();
          },
        };
        if (closed || fenced.has(selected.id) || exitedDuringAdmission) {
          await session.close("shutdown");
          throw new Error("Cursor instance was fenced during admission");
        }
        sessions.set(session, selected.id);
        return session;
      } catch (error) {
        lease?.end();
        throw error;
      } finally {
        opening--;
        admissions.delete(admission);
        admissionDone();
      }
    },
    async stopInstance(id) {
      if (id !== selected.id)
        throw new Error("Cannot stop another provider instance through this owner");
      fenced.add(id);
      await Promise.all(
        [...admissions].filter(([, instance]) => instance === id).map(([pending]) => pending),
      );
      const results = await Promise.allSettled(
        [...sessions]
          .filter(([, instance]) => instance === id)
          .map(([session]) => session.close("user")),
      );
      if (results.some((result) => result.status === "rejected"))
        throw new Error("SDK hosts did not confirm exit; retain account writer reservation");
    },
    async close() {
      closed = true;
      await Promise.all(admissions.keys());
      const results = await Promise.allSettled(
        [...sessions.keys()].map((session) => session.close("shutdown")),
      );
      if (results.some((result) => result.status === "rejected"))
        throw new Error("SDK shutdown incomplete");
    },
  };
}
