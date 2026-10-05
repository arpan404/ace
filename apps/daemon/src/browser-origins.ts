import { originAccess, BrowserOriginError, type OriginRequest } from "@ace/browser";
import { reviewPermission } from "@ace/core";
import {
  AgentId,
  BrowserOrigin,
  Interaction,
  InteractionId,
  ThreadId,
  type Command,
  type CommandResult,
  type PermissionMode,
} from "@ace/protocol";
import { z } from "zod";
import type { Store } from "./store.ts";
import { BrowserOriginGrants } from "./browser-origin-grants.ts";

const Pending = z.object({ thread_id: ThreadId, interaction_id: InteractionId });
/** SQLite owns grants; page-only grants and approval waiters never survive a restart. */
export class BrowserOrigins {
  private store: Store;
  private grants: BrowserOriginGrants;
  private now: () => number;
  private id: () => string;
  private mode: (threadId: ThreadId) => Promise<PermissionMode>;
  private allowlist: () => Promise<string[]>;
  private once = new Map<string, Set<string>>();
  private waiters = new Map<string, () => void>();
  private stop: () => void;
  private timeout: number;
  private closing = false;
  private root: ((threadId: ThreadId) => string | undefined) | undefined;
  private open: ((interaction: Interaction) => Interaction) | undefined;
  private closeInteraction:
    | ((
        threadId: ThreadId,
        interactionId: InteractionId,
        result: {
          state: "resolved" | "expired";
          resolution?: import("@ace/protocol").InteractionResolution;
          resolvedBy?: import("@ace/protocol").DeviceId;
        },
      ) => void)
    | undefined;
  constructor(options: {
    store: Store;
    now(): number;
    id(): string;
    mode(threadId: ThreadId): Promise<PermissionMode>;
    allowlist(): Promise<string[]>;
    timeoutMs?: number;
    deferRecovery?: boolean;
    root?: (threadId: ThreadId) => string | undefined;
    open?: (interaction: Interaction) => Interaction;
    closeInteraction?: BrowserOrigins["closeInteraction"];
  }) {
    this.store = options.store;
    this.now = options.now;
    this.grants = new BrowserOriginGrants(this.store, this.now);
    this.id = options.id;
    this.mode = options.mode;
    this.allowlist = options.allowlist;
    this.timeout = z
      .number()
      .int()
      .min(1)
      .max(60_000)
      .parse(options.timeoutMs ?? 60_000);
    this.root = options.root;
    this.open = options.open;
    this.closeInteraction = options.closeInteraction;
    this.store.atomic((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS browser_origin_pending (
        interaction_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE
      );
    `),
    );
    if (!options.deferRecovery) this.recover();
    this.stop = this.store.subscribe((events) => {
      for (const event of events)
        if (event.payload.type === "interaction.closed")
          this.waiters.get(event.payload.interactionId)?.();
    });
  }
  recover(): void {
    const pending = this.store.atomic((db) =>
      db.prepare("SELECT * FROM browser_origin_pending").all(),
    );
    for (const raw of pending) {
      const row = Pending.parse(raw);
      this.expire(row.thread_id, row.interaction_id);
    }
  }
  list(threadId: string) {
    return this.grants.list(threadId);
  }
  grant(threadId: string, origin: string): void {
    this.grants.grant(threadId, origin);
  }
  revoke(threadId: string, origin: string): void {
    this.grants.revoke(threadId, origin);
    this.once.get(threadId)?.delete(origin);
  }
  clearPage(threadId: string): void {
    this.once.delete(threadId);
  }
  private pageGrant(threadId: string, origin: string): void {
    const origins = this.once.get(threadId) ?? new Set<string>();
    if (origins.size >= 256) throw new Error("Browser page origin limit");
    origins.add(origin);
    this.once.set(threadId, origins);
  }
  async allowed(request: OriginRequest): Promise<boolean> {
    if (this.closing) throw new Error("Browser origin policy is shutting down");
    const threadId = ThreadId.parse(request.threadId),
      { origin } = request;
    if (request.human) {
      if (request.navigation) this.grant(threadId, origin);
      return true;
    }
    const mode = await this.mode(threadId);
    const facts = { origin, mode, human: false, navigation: request.navigation === true };
    if (originAccess({ ...facts, granted: false }) === "read_only")
      throw new BrowserOriginError(
        origin,
        "read_only",
        "Read-only mode refuses agent browser navigation",
      );
    const granted =
      this.once.get(threadId)?.has(origin) === true ||
      this.grants.has(threadId, origin) ||
      (await this.allowlist()).includes(origin);
    request.signal?.throwIfAborted();
    if (this.closing) throw new Error("Browser origin policy is shutting down");
    const decision = originAccess({ ...facts, granted });
    if (decision === "allow") return true;
    if (decision === "block") return false;
    if (decision === "page_grant") {
      this.pageGrant(threadId, origin);
      return true;
    }
    if (this.waiters.size >= 32) throw new Error("Browser approval limit");
    const thread = this.store.getThread(threadId);
    const root = this.root?.(threadId) ?? thread?.rootAgentId;
    if (!root)
      throw new BrowserOriginError(
        origin,
        "approval_required",
        "Browser approval requires an active thread agent",
      );
    const action = `open ${origin} in the thread browser`;
    let interaction = Interaction.parse({
      id: this.id(),
      threadId,
      agentId: AgentId.parse(root),
      blocking: true,
      state: "pending",
      createdAt: this.now(),
      request: {
        kind: "approval",
        title: action,
        description: action,
        target: {
          tool: "ace_browser_navigate",
          access: "execute",
          input: { action, origin, url: request.url },
        },
        options: [
          { id: "allow_once", kind: "allow_once", label: "Allow once" },
          { id: "allow_thread", kind: "allow_session", label: "Allow for this thread" },
          { id: "deny", kind: "deny", label: "Deny" },
        ],
        defaultToNo: true,
      },
      raw: [{ type: "ace.browser.origin", data: { origin, key: `browser-origin:${this.id()}` } }],
    });
    this.store.atomic((db) => {
      if (this.open) interaction = this.open(interaction);
      else
        this.store.appendEvents(
          threadId,
          [{ type: "interaction.opened", interaction }],
          this.now(),
        );
      db.prepare("INSERT INTO browser_origin_pending VALUES (?,?)").run(interaction.id, threadId);
      if (mode === "auto-review" && !this.store.getInteraction(interaction.id)?.review) {
        const review = reviewPermission({
          mode,
          ...(interaction.request.kind === "approval" && interaction.request.target
            ? { target: interaction.request.target }
            : {}),
          paths: [],
        });
        this.store.appendEvents(
          threadId,
          [
            {
              type: "permission.reviewed",
              review: {
                interactionId: interaction.id,
                mode,
                ...review,
                reviewer: "ace-risk-policy",
                ...(interaction.request.kind === "approval"
                  ? { target: interaction.request.target }
                  : {}),
              },
            },
          ],
          this.now(),
        );
      }
    });
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
        this.waiters.delete(interaction.id);
        resolve();
      };
      const abort = () => {
        this.expire(threadId, interaction.id);
        finish();
      };
      const timer = setTimeout(abort, this.timeout);
      this.waiters.set(interaction.id, finish);
      request.signal?.addEventListener("abort", abort, { once: true });
      if (request.signal?.aborted || this.store.getInteraction(interaction.id)?.state !== "pending")
        abort();
    });
    const result = this.store.getInteraction(interaction.id);
    this.store.atomic((db) =>
      db.prepare("DELETE FROM browser_origin_pending WHERE interaction_id=?").run(interaction.id),
    );
    if (result?.state !== "resolved")
      throw new BrowserOriginError(
        origin,
        "timeout",
        "Browser origin approval expired or was cancelled",
      );
    if (result.resolution?.kind !== "approval" || result.resolution.optionId === "deny")
      throw new BrowserOriginError(origin, "denied", "Browser origin approval denied");
    // A mode change during the wait cannot authorize a now forbidden action.
    if ((await this.mode(threadId)) === "read-only")
      throw new BrowserOriginError(
        origin,
        "read_only",
        "Read-only mode refuses agent browser navigation",
      );
    this.pageGrant(threadId, origin);
    return true;
  }
  /** Called inside the existing command receipt and authorization boundary. */
  resolve(command: Command): CommandResult | undefined {
    if (command.payload.type !== "interaction.resolve") return undefined;
    const p = command.payload;
    const row = this.store.atomic((db) =>
      db
        .prepare("SELECT * FROM browser_origin_pending WHERE interaction_id=?")
        .get(p.interactionId),
    );
    if (!row) return undefined;
    const pending = Pending.parse(row),
      interaction = this.store.getInteraction(p.interactionId);
    const fail = (error: string) => ({ commandId: command.id, ok: false, error });
    if (interaction?.state !== "pending") return fail("already_resolved");
    if (
      p.resolution.kind !== "approval" ||
      !["allow_once", "allow_thread", "deny"].includes(p.resolution.optionId)
    )
      return fail("invalid_resolution");
    const resolution = p.resolution;
    this.store.atomic(() => {
      if (resolution.optionId === "allow_thread") {
        const raw = interaction.raw.find((entry) => entry.type === "ace.browser.origin");
        this.grant(
          pending.thread_id,
          z.object({ origin: BrowserOrigin }).parse(raw && "data" in raw ? raw.data : undefined)
            .origin,
        );
      }
      this.closed(pending.thread_id, p.interactionId, {
        state: "resolved",
        resolvedBy: command.deviceId,
        resolution,
      });
    });
    return { commandId: command.id, ok: true, threadId: pending.thread_id };
  }
  private closed(
    threadId: ThreadId,
    interactionId: InteractionId,
    result: {
      state: "resolved" | "expired";
      resolution?: import("@ace/protocol").InteractionResolution;
      resolvedBy?: import("@ace/protocol").DeviceId;
    },
  ): void {
    if (this.closeInteraction) this.closeInteraction(threadId, interactionId, result);
    else
      this.store.appendEvents(
        threadId,
        [{ type: "interaction.closed", interactionId, closedAt: this.now(), ...result }],
        this.now(),
      );
  }
  private expire(threadId: ThreadId, interactionId: InteractionId): void {
    if (this.store.getInteraction(interactionId)?.state === "pending")
      this.closed(threadId, interactionId, { state: "expired" });
    this.store.atomic((db) =>
      db.prepare("DELETE FROM browser_origin_pending WHERE interaction_id=?").run(interactionId),
    );
  }
  close(): void {
    if (this.closing) return;
    this.closing = true;
    const pending = this.store.atomic((db) =>
      db.prepare("SELECT * FROM browser_origin_pending").all(),
    );
    for (const raw of pending) {
      const row = Pending.parse(raw);
      this.expire(row.thread_id, row.interaction_id);
    }
    this.stop();
    for (const finish of this.waiters.values()) finish();
    this.once.clear();
  }
}
