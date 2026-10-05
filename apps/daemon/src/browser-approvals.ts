import { reviewPermission } from "@ace/core";
import { z } from "zod";
import {
  BrowserOrigin,
  BrowserEvaluateGrant,
  Interaction,
  InteractionId,
  ThreadId,
  type Command,
  type CommandResult,
  type PermissionMode,
} from "@ace/protocol";
import { browserOrigin } from "@ace/browser";
import type { Store } from "./store.ts";
const Metadata = z.object({
  key: z.string(),
  origin: z.string(),
  kind: z.enum(["evaluate", "downloads", "upload"]),
  mode: z.enum(["read-only", "unrestricted"]).optional(),
});
interface Host {
  store: Store;
  now(): number;
  id(): string;
  mode(threadId: ThreadId): Promise<PermissionMode>;
  root(threadId: ThreadId): string | undefined;
  open(interaction: Interaction): Interaction;
  close(
    threadId: ThreadId,
    key: string,
    result: {
      state: "resolved" | "expired";
      resolution?: import("@ace/protocol").InteractionResolution;
      resolvedBy?: import("@ace/protocol").DeviceId;
    },
    interactionId: string,
  ): void;
}
/** Daemon-owned host approvals; site grants never imply evaluate/file permission. */
export class BrowserApprovals {
  private host: Host;
  private waiters = new Map<string, () => void>();
  private pending = new Map<string, { threadId: ThreadId; key: string }>();
  private versions = new Map<string, number>();
  private stop: () => void;
  private closed = false;
  constructor(host: Host) {
    this.host = host;
    host.store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS browser_evaluate_grants (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      origin TEXT NOT NULL, granted_at REAL NOT NULL, PRIMARY KEY(thread_id,origin));
      CREATE TABLE IF NOT EXISTS browser_permission_pending (
        interaction_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, key TEXT NOT NULL);`),
    );
    this.stop = host.store.subscribe((events) => {
      for (const event of events)
        if (event.payload.type === "interaction.closed")
          this.waiters.get(event.payload.interactionId)?.();
    });
  }
  recover(): void {
    const rows = this.host.store.atomic((db) =>
      db.prepare("SELECT * FROM browser_permission_pending").all(),
    );
    for (const raw of rows) {
      const row = z
        .object({ interaction_id: z.string(), thread_id: ThreadId, key: z.string() })
        .parse(raw);
      this.expire(row.interaction_id, { threadId: row.thread_id, key: row.key });
    }
  }
  list(threadId: string) {
    return this.host.store
      .atomic((db) =>
        db
          .prepare(
            "SELECT origin, 'read-only' AS mode, granted_at AS grantedAt FROM browser_evaluate_grants WHERE thread_id=? ORDER BY origin",
          )
          .all(ThreadId.parse(threadId)),
      )
      .map((row) => BrowserEvaluateGrant.parse(row));
  }
  revoke(threadId: string, raw: string): void {
    const origin = BrowserOrigin.parse(raw),
      key = `${threadId}:${origin}`;
    if (this.versions.size >= 16_384 && !this.versions.has(key))
      throw new Error("Evaluate revocation limit");
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.host.store.atomic((db) =>
      db
        .prepare("DELETE FROM browser_evaluate_grants WHERE thread_id=? AND origin=?")
        .run(ThreadId.parse(threadId), origin),
    );
    for (const [id, pending] of this.pending) {
      const interaction = this.host.store.getInteraction(InteractionId.parse(id));
      const metadata = this.metadata(interaction);
      if (pending.threadId === threadId && metadata?.origin === origin) this.expire(id, pending);
    }
  }
  evaluate(
    threadId: string,
    url: string,
    signal?: AbortSignal,
    mode: "read-only" | "unrestricted" = "unrestricted",
    expression?: string,
  ) {
    return this.request(threadId, url, "evaluate", signal, mode, undefined, expression);
  }
  downloads(threadId: string, url: string, signal?: AbortSignal) {
    return this.request(threadId, url, "downloads", signal);
  }
  upload(threadId: string, paths: string[], signal?: AbortSignal) {
    return this.request(threadId, "", "upload", signal, undefined, paths);
  }
  private metadata(interaction: Interaction | undefined) {
    const raw = interaction?.raw.find((entry) => entry.type === "ace.browser.permission");
    const parsed = Metadata.safeParse(raw && "data" in raw ? raw.data : undefined);
    return parsed.success ? parsed.data : undefined;
  }
  private async request(
    rawThreadId: string,
    url: string,
    kind: "evaluate" | "downloads" | "upload",
    signal?: AbortSignal,
    mode?: "read-only" | "unrestricted",
    paths?: string[],
    expression?: string,
  ): Promise<boolean> {
    const threadId = ThreadId.parse(rawThreadId),
      origin = kind === "upload" ? "" : browserOrigin(url);
    if (this.closed) return false;
    const authority = await this.host.mode(threadId);
    signal?.throwIfAborted();
    if (authority === "read-only" && (kind !== "evaluate" || mode !== "read-only")) return false;
    if (
      authority === "full-access" &&
      kind !== "upload" &&
      (origin !== undefined || (kind === "evaluate" && url === "about:blank"))
    )
      return true;
    if (origin === undefined) return false;
    if (
      kind === "evaluate" &&
      mode === "read-only" &&
      this.list(threadId).some((grant) => grant.origin === origin)
    )
      return true;
    if (this.pending.size >= 32) return false;
    const agentId = this.host.root(threadId);
    if (!agentId) return false;
    const key = `browser-${kind}:${this.host.id()}`;
    const versionKey = `${threadId}:${origin}`,
      version = this.versions.get(versionKey) ?? 0;
    const interaction = this.host.open(
      Interaction.parse({
        id: this.host.id(),
        threadId,
        agentId,
        blocking: true,
        state: "pending",
        createdAt: this.host.now(),
        request: {
          kind: "approval",
          title: `Browser ${kind} approval`,
          description:
            kind === "upload"
              ? "Upload files outside this thread's workspace/artifacts"
              : `${kind} on ${origin}${mode ? ` (${mode})` : ""}`,
          target: {
            tool: `browser.${kind}`,
            origin: "ace",
            access: kind === "evaluate" && mode === "read-only" ? "read" : "execute",
            riskClass: "external-effect",
            input: { origin, url, mode, paths, expression },
          },
          options: [
            { id: "allow_once", kind: "allow_once", label: "Allow once" },
            ...(kind === "evaluate" && mode === "read-only"
              ? [
                  {
                    id: "allow_site",
                    kind: "allow_session",
                    label: "Allow read-only JS for this site in this thread",
                  },
                ]
              : []),
            { id: "deny", kind: "deny", label: "Deny" },
          ],
          defaultToNo: true,
        },
        raw: [{ type: "ace.browser.permission", data: { key, kind, origin, mode } }],
      }),
    );
    this.host.store.atomic((db) => {
      db.prepare("INSERT INTO browser_permission_pending VALUES (?,?,?)").run(
        interaction.id,
        threadId,
        key,
      );
      if (authority === "auto-review" && !this.host.store.getInteraction(interaction.id)?.review) {
        const target =
          interaction.request.kind === "approval" ? interaction.request.target : undefined;
        const review = reviewPermission({
          mode: authority,
          ...(target ? { target } : {}),
          paths: [],
        });
        this.host.store.appendEvents(
          threadId,
          [
            {
              type: "permission.reviewed",
              review: {
                interactionId: interaction.id,
                mode: authority,
                ...review,
                reviewer: "ace-risk-policy",
                ...(target ? { target } : {}),
              },
            },
          ],
          this.host.now(),
        );
      }
    });
    const pending = { threadId, key };
    this.pending.set(interaction.id, pending);
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.waiters.delete(interaction.id);
        resolve();
      };
      const abort = () => {
        this.expire(interaction.id, pending);
        finish();
      };
      const timer = setTimeout(abort, 60_000);
      this.waiters.set(interaction.id, finish);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted || this.host.store.getInteraction(interaction.id)?.state !== "pending")
        finish();
    });
    this.pending.delete(interaction.id);
    this.host.store.atomic((db) =>
      db
        .prepare("DELETE FROM browser_permission_pending WHERE interaction_id=?")
        .run(interaction.id),
    );
    signal?.throwIfAborted();
    if (this.closed || version !== (this.versions.get(versionKey) ?? 0)) return false;
    const result = this.host.store.getInteraction(interaction.id);
    const latest = await this.host.mode(threadId);
    if (latest === "read-only" && (kind !== "evaluate" || mode !== "read-only")) return false;
    return (
      result?.state === "resolved" &&
      result.resolution?.kind === "approval" &&
      ["allow_once", "allow_site"].includes(result.resolution.optionId)
    );
  }
  resolve(command: Command): CommandResult | undefined {
    if (command.payload.type !== "interaction.resolve") return;
    const payload = command.payload,
      interaction = this.host.store.getInteraction(payload.interactionId),
      metadata = this.metadata(interaction);
    if (interaction?.raw.some((raw) => raw.type === "ace.browser.private"))
      return { commandId: command.id, ok: false, error: "private_handback_required" };
    if (!metadata) return;
    const fail = (error: string) => ({ commandId: command.id, ok: false, error });
    if (interaction?.state !== "pending" || !this.pending.has(payload.interactionId))
      return fail("interaction_unavailable");
    if (
      payload.resolution.kind !== "approval" ||
      ![
        "allow_once",
        "deny",
        ...(metadata.kind === "evaluate" && metadata.mode === "read-only" ? ["allow_site"] : []),
      ].includes(payload.resolution.optionId)
    )
      return fail("invalid_resolution");
    this.host.store.atomic((db) => {
      if (payload.resolution.kind === "approval" && payload.resolution.optionId === "allow_site") {
        if (this.list(interaction.threadId).length >= 256) throw new Error("Evaluate grant limit");
        db.prepare(
          "INSERT INTO browser_evaluate_grants VALUES (?,?,?) ON CONFLICT(thread_id,origin) DO NOTHING",
        ).run(interaction.threadId, BrowserOrigin.parse(metadata.origin), this.host.now());
      }
      this.host.close(
        interaction.threadId,
        metadata.key,
        {
          state: "resolved",
          resolution: payload.resolution,
          resolvedBy: command.deviceId,
        },
        interaction.id,
      );
    });
    return { commandId: command.id, ok: true, threadId: interaction.threadId };
  }
  private expire(id: string, pending: { threadId: ThreadId; key: string }): void {
    if (this.host.store.getInteraction(InteractionId.parse(id))?.state === "pending")
      this.host.close(pending.threadId, pending.key, { state: "expired" }, id);
    this.host.store.atomic((db) =>
      db.prepare("DELETE FROM browser_permission_pending WHERE interaction_id=?").run(id),
    );
  }
  close(): void {
    this.closed = true;
    for (const [id, pending] of this.pending) this.expire(id, pending);
    this.stop();
    for (const finish of this.waiters.values()) finish();
    this.pending.clear();
    this.versions.clear();
  }
}
