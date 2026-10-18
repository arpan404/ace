import { z } from "zod";
import {
  BrowserHelpReason,
  Command,
  ThreadId,
  type CommandResult,
  type InteractionRequest,
  type McpAttribution,
} from "@ace/protocol";
import { PublicToolError } from "@ace/mcp-server/errors";
import type { Engine } from "./engine/index.ts";
import type { Store } from "./store.ts";
import { commandContext } from "./commands.ts";

export const BrowserHelpInput = z.strictObject({
  tabId: z.string().min(1).max(256),
  reason: BrowserHelpReason,
  message: z
    .string()
    .min(1)
    .max(1000)
    .describe("One sentence for the person: what to do in the tab, such as which account."),
  timeoutSeconds: z.number().int().min(5).max(240).default(240),
});
export type BrowserHelpInput = z.output<typeof BrowserHelpInput>;
export const BrowserHelpResult = z.object({
  /** `done`: the person finished in the tab. `skipped`: they won't. `pending`: not yet. */
  status: z.enum(["done", "skipped", "pending"]),
  requestId: z.string(),
  tabId: z.string(),
});
export type BrowserHelpResult = z.infer<typeof BrowserHelpResult>;

const Pending = z.object({
  interaction_id: z.string(),
  thread_id: z.string(),
  key: z.string(),
  tab_id: z.string(),
  summary: z.string(),
});
type Pending = z.infer<typeof Pending>;
type Outcome = "done" | "skipped";

/** What the thread's browser reports about a tab; undefined when it has no such tab. */
export type BrowserHelpTab = (
  threadId: ThreadId,
  tabId: string,
  agentId: string,
) => { url: string; title: string } | undefined;

/**
 * `browser_request_help`: an agent hands a browser tab to the person (sign in, a CAPTCHA, a
 * code, a dialog). The thread needs the person until they press Done or Skip in the composer's
 * strip, or until the agent carries on without them (a new turn starts). The tool waits a
 * bounded time; after that it returns pending and the person's Done arrives as their next
 * message, so ace never starts a turn by itself. Agents can never answer it.
 */
export class BrowserHelp {
  private readonly waiters = new Map<string, (outcome: Outcome | undefined) => void>();
  private readonly deps: {
    store: Store;
    engine(): Engine | undefined;
    tab: BrowserHelpTab;
    id(): string;
    schedule(run: () => void, ms: number): () => void;
  };
  constructor(deps: BrowserHelp["deps"]) {
    this.deps = deps;
    deps.store.atomic((db) =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS browser_help_pending (interaction_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, key TEXT NOT NULL, tab_id TEXT NOT NULL, summary TEXT NOT NULL)",
      ),
    );
  }

  async request(
    caller: McpAttribution,
    input: BrowserHelpInput,
    signal: AbortSignal,
  ): Promise<BrowserHelpResult> {
    const engine = this.deps.engine();
    if (!engine) throw new Error("Asking for help is unavailable");
    const threadId = ThreadId.parse(caller.threadId);
    const tab = this.deps.tab(threadId, input.tabId, caller.agentId);
    if (!tab) throw new PublicToolError("tab_not_found");
    // Asking again about the same tab waits on the request already open.
    const open = this.pending(threadId).find((row) => row.tab_id === input.tabId);
    const interactionId = open?.interaction_id ?? this.open(engine, threadId, input, tab);
    const outcome = await new Promise<Outcome | undefined>((resolve) => {
      const finish = (value: Outcome | undefined) => {
        cancel();
        signal.removeEventListener("abort", stop);
        if (this.waiters.get(interactionId) === finish) this.waiters.delete(interactionId);
        resolve(value);
      };
      const stop = () => finish(undefined);
      const cancel = this.deps.schedule(stop, input.timeoutSeconds * 1000);
      // A second wait on the same request replaces the first, which returns pending.
      this.waiters.get(interactionId)?.(undefined);
      this.waiters.set(interactionId, finish);
      signal.addEventListener("abort", stop, { once: true });
    });
    return { status: outcome ?? "pending", requestId: interactionId, tabId: input.tabId };
  }

  /** Host-interaction hook: only a person's answer to an open help request is handled here. */
  resolve(command: Command): CommandResult | undefined {
    if (command.payload.type !== "interaction.resolve") return;
    const { interactionId, resolution } = command.payload;
    const row = this.row(interactionId);
    if (!row) return;
    const fail = (error: string) => ({ commandId: command.id, ok: false, error });
    if (["ace-reviewer", "ace-agent"].includes(command.deviceId))
      return fail("human_answer_required");
    if (resolution.kind !== "browser_help") return fail("invalid_resolution");
    const engine = this.deps.engine();
    if (!engine) return fail("engine_unavailable");
    const threadId = ThreadId.parse(row.thread_id);
    engine.resolveHostApproval(threadId, row.key, {
      state: "resolved",
      resolution,
      resolvedBy: command.deviceId,
    });
    this.forget(interactionId);
    const waiter = this.waiters.get(interactionId);
    if (waiter) waiter(resolution.outcome);
    else this.deliverLate(command, threadId, row, resolution.outcome);
    return { commandId: command.id, ok: true };
  }

  /**
   * The agent carried on (a new turn started) while no call waits on its request: the request
   * is withdrawn, so the thread no longer reads as needing the person for it.
   */
  withdrawIdle(threadId: ThreadId): void {
    const engine = this.deps.engine();
    if (!engine) return;
    for (const row of this.pending(threadId)) {
      if (this.waiters.has(row.interaction_id)) continue;
      engine.resolveHostApproval(threadId, row.key, { state: "cancelled" });
      this.forget(row.interaction_id);
    }
  }

  private open(
    engine: Engine,
    threadId: ThreadId,
    input: BrowserHelpInput,
    tab: { url: string; title: string },
  ): string {
    const key = `ace-browser-help:${this.deps.id()}`;
    const request: InteractionRequest = {
      kind: "browser_help",
      tabId: input.tabId,
      reason: input.reason,
      message: input.message,
      ...(tab.url ? { url: tab.url.slice(0, 8192) } : {}),
      ...(tab.title ? { title: tab.title.slice(0, 1024) } : {}),
    };
    const interactionId = engine.openHostApproval(threadId, key, request, [
      { type: "ace.browser_help", data: { key, tabId: input.tabId } },
    ]);
    const summary = `${input.message} (tab ${input.tabId}${tab.url ? `, ${tab.url}` : ""})`;
    this.deps.store.atomic((db) =>
      db
        .prepare("INSERT INTO browser_help_pending VALUES (?,?,?,?,?)")
        .run(interactionId, threadId, key, input.tabId, summary.slice(0, 2000)),
    );
    return interactionId;
  }

  private row(interactionId: string): Pending | undefined {
    const row = this.deps.store.atomic((db) =>
      db.prepare("SELECT * FROM browser_help_pending WHERE interaction_id=?").get(interactionId),
    );
    return row ? Pending.parse(row) : undefined;
  }

  private pending(threadId: ThreadId): Pending[] {
    return this.deps.store
      .atomic((db) =>
        db.prepare("SELECT * FROM browser_help_pending WHERE thread_id=?").all(threadId),
      )
      .map((row) => Pending.parse(row));
  }

  private forget(interactionId: string): void {
    this.deps.store.atomic((db) =>
      db.prepare("DELETE FROM browser_help_pending WHERE interaction_id=?").run(interactionId),
    );
  }

  /** The tool already returned pending: the person's outcome becomes their next message. */
  private deliverLate(command: Command, threadId: ThreadId, row: Pending, outcome: Outcome) {
    const engine = this.deps.engine();
    if (!engine) return;
    const text =
      outcome === "done"
        ? `I did what you asked in the browser: ${row.summary}. Carry on.`
        : `I skipped what you asked in the browser: ${row.summary}.`;
    const send = Command.parse({
      id: `${command.id}:browser-help`,
      deviceId: command.deviceId,
      payload: {
        type: "thread.send",
        threadId,
        delivery: "queue",
        input: [{ type: "text", text }],
      },
    });
    this.deps.store.recordCommand(send.id, send.deviceId, () =>
      engine.internalHandler.handle(send, commandContext(this.deps.store)),
    );
  }
}
