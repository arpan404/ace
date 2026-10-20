import type { AccessMode, McpAttribution } from "@ace/protocol";
import type { Principal } from "./credentials.ts";
import { renderBrief, renderDigest, type SessionFacts } from "./brief.ts";
import { renderRoles, type SessionRoles } from "./roles.ts";

/** The daemon's canonical facts for one caller. Groups and failures are known to the server. */
export interface AwarenessPort {
  facts(
    caller: McpAttribution,
  ): Omit<SessionFacts, "groups" | "delegates" | "lastFailure"> | undefined;
  /** Only read for the brief: it may page a model catalog. */
  delegates(caller: McpAttribution): SessionFacts["delegates"];
  /** The person's roles from Settings, read once per session. */
  roles?(): SessionRoles;
}

/**
 * Per-lease brief and "since your last ace call" digest. The last-seen facts live with the lease
 * (a WeakMap on its principal), so they end with it and are never shared between sessions.
 */
export class SessionAwareness {
  private readonly seen = new WeakMap<Principal, SessionFacts>();
  private readonly failures = new WeakMap<Principal, string>();
  /** Each session's roles line as first read; a later settings change never alters it. */
  private readonly roles = new WeakMap<Principal, string | null>();
  /** Recent failed calls per session id, newest last; bounded in sessions and entries. */
  private readonly failureLog = new Map<string, { tool: string; code: string; count: number }[]>();
  private readonly port: AwarenessPort;
  private readonly groups: (principal: Principal) => string[];
  private readonly tools: (principal: Principal) => string[];
  /** `tools` names what the session can call, for providers whose model never sees the list. */
  constructor(
    port: AwarenessPort,
    groups: (principal: Principal) => string[],
    tools: (principal: Principal) => string[] = () => [],
  ) {
    this.port = port;
    this.groups = groups;
    this.tools = tools;
  }
  private current(principal: Principal, delegates: boolean): SessionFacts | undefined {
    const facts = this.port.facts(principal.scope);
    if (!facts) return undefined;
    return {
      ...facts,
      groups: this.groups(principal),
      delegates: delegates ? this.port.delegates(principal.scope) : [],
      lastFailure: this.failures.get(principal) ?? null,
    };
  }
  /** Full facts; reading them does not advance the digest. */
  facts(principal: Principal): SessionFacts | undefined {
    return this.current(principal, true);
  }
  /**
   * The brief, enabled groups, roles line, callable tools and access mode. The first read marks what
   * this session has seen and fixes its roles line for the rest of the session.
   */
  guidance(principal: Principal): {
    brief?: string;
    groups?: string[];
    roles?: string;
    tools?: string[];
    access?: AccessMode;
  } {
    const facts = this.current(principal, true);
    if (!facts) return {};
    if (!this.seen.has(principal)) this.seen.set(principal, facts);
    const roles = this.rolesLine(principal);
    const tools = this.tools(principal);
    return {
      brief: renderBrief(facts),
      groups: [...facts.groups],
      ...(roles ? { roles } : {}),
      ...(tools.length ? { tools } : {}),
      ...(facts.access ? { access: facts.access } : {}),
    };
  }
  /** This session's roles line, rendered on its first read and kept as it was. */
  rolesLine(principal: Principal): string | undefined {
    let line = this.roles.get(principal);
    if (line === undefined) {
      line = renderRoles(this.port.roles?.() ?? {}) ?? null;
      this.roles.set(principal, line);
    }
    return line ?? undefined;
  }
  brief(principal: Principal): string | undefined {
    return this.guidance(principal).brief;
  }
  /** What changed since this session last heard from ace, then mark it seen. */
  changes(principal: Principal): string | undefined {
    const facts = this.current(principal, false);
    if (!facts) return undefined;
    const before = this.seen.get(principal);
    this.seen.set(principal, facts);
    return before ? renderDigest(before, facts) : undefined;
  }
  failed(principal: Principal, tool: string, code: string): void {
    this.failures.set(principal, `${tool} ${code}`.slice(0, 120));
    const session = principal.scope.sessionId;
    const log = this.failureLog.get(session) ?? [];
    this.failureLog.delete(session);
    const last = log.at(-1);
    if (last && last.tool === tool && last.code === code) last.count++;
    else log.push({ tool: tool.slice(0, 128), code: code.slice(0, 64), count: 1 });
    if (log.length > 20) log.shift();
    this.failureLog.set(session, log);
    if (this.failureLog.size > 1024) {
      const oldest = this.failureLog.keys().next().value;
      if (oldest !== undefined) this.failureLog.delete(oldest);
    }
  }
  /** This session's failed ace calls, newest first; repeats of the same failure are counted. */
  recentFailures(sessionId: string): { tool: string; code: string; count: number }[] {
    return (this.failureLog.get(sessionId) ?? []).toReversed().map(({ tool, code, count }) => ({
      tool,
      code,
      count,
    }));
  }
}
